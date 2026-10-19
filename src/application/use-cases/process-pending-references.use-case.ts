import { randomUUID } from "node:crypto";
import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/integration-events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  BusinessRuleViolationError,
  CurrencyMismatchError,
} from "../../domain/shared/domain-error";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/enums";
import { StructuredLoggerService } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import {
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from "../../infrastructure/persistence/entities/orm-entities";
import {
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../../infrastructure/persistence/mappers/domain-mappers";

export interface ProcessPendingReferencesResult {
  processed: number;
  rejected: number;
  retried: number;
}

@Injectable()
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  async executeBatch(
    options: { maxAttempts?: number; batchSize?: number; forceDue?: boolean } = {},
  ): Promise<ProcessPendingReferencesResult> {
    const maxAttempts =
      options.maxAttempts ??
      Number(process.env.PENDING_REF_MAX_ATTEMPTS ?? 5);
    const batchSize = options.batchSize ?? 25;
    const fork = this.em.fork();

    const candidateRows = await fork.getConnection().execute<
      Array<{ id: string }>
    >(
      options.forceDue
        ? `SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE'
           ORDER BY created_at ASC
           LIMIT ?`
        : `SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE'
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           ORDER BY next_retry_at ASC NULLS FIRST, created_at ASC
           LIMIT ?`,
      [batchSize],
    );

    let processed = 0;
    let rejected = 0;
    let retried = 0;

    for (const row of candidateRows) {
      const outcome = await this.processSinglePendingTransaction(
        row.id,
        maxAttempts,
      );
      if (outcome === "PROCESSED") processed++;
      else if (outcome === "REJECTED") rejected++;
      else if (outcome === "RETRIED") retried++;
    }

    return { processed, rejected, retried };
  }

  private async processSinglePendingTransaction(
    transactionId: string,
    maxAttempts: number,
  ): Promise<"PROCESSED" | "REJECTED" | "RETRIED" | "SKIPPED"> {
    const correlationId = randomUUID();

    return this.em.fork().transactional(async (txEm) => {
      const lockedRows = await txEm.getConnection().execute<
        Array<{ id: string; wallet_id: string }>
      >(
        `SELECT id, wallet_id FROM wager_transactions
         WHERE id = ? AND status = 'PENDING_REFERENCE'
         FOR UPDATE SKIP LOCKED`,
        [transactionId],
      );

      const locked = lockedRows[0];
      if (!locked) {
        return "SKIPPED";
      }

      const walletOrm = await txEm.findOne(
        WalletOrmEntity,
        { id: locked.wallet_id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      const txOrm = await txEm.findOne(
        WagerTransactionOrmEntity,
        { id: locked.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (
        !walletOrm ||
        !txOrm ||
        txOrm.status !== WagerTransactionStatus.PendingReference
      ) {
        return "SKIPPED";
      }

      const wallet = WalletMapper.toDomain(walletOrm);
      const tx = WagerTransactionMapper.toDomain(txOrm);
      const now = new Date();

      const refOrm = tx.referenceExternalTransactionId
        ? await txEm.findOne(
            WagerTransactionOrmEntity,
            {
              providerId: tx.providerId,
              externalTransactionId: tx.referenceExternalTransactionId,
            },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          )
        : null;

      if (
        !refOrm ||
        refOrm.status === WagerTransactionStatus.Pending ||
        refOrm.status === WagerTransactionStatus.PendingReference
      ) {
        if (tx.retryCount + 1 >= maxAttempts) {
          tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
          WagerTransactionMapper.toPersistence(tx, txOrm);

          const rejectedEvent = WagerTransactionRejected.from(tx, {
            correlationId,
            occurredAt: now,
          });
          txEm.persist(
            OutboxMessageMapper.toPersistence(
              OutboxMessage.enqueue(rejectedEvent),
            ),
          );
          await txEm.flush();

          this.metrics.recordTransactionStatus(
            WagerTransactionStatus.Rejected,
            tx.kind,
            FailureCode.ReferenceNotFound,
          );
          this.logger.warn(
            "PENDING_REFERENCE transaction rejected after exhausting retries",
            {
              event: "pending_reference_exhausted",
              correlationId,
              transactionId: tx.id,
              walletId: tx.walletId,
              providerId: tx.providerId,
              failureCode: FailureCode.ReferenceNotFound,
            },
          );
          return "REJECTED";
        }

        tx.scheduleReferenceRetry(now);
        WagerTransactionMapper.toPersistence(tx, txOrm);
        await txEm.flush();

        this.metrics.incrementRetry("pendingReference");
        return "RETRIED";
      }

      // Reference found and in a terminal state!
      try {
        const refDomain = WagerTransactionMapper.toDomain(refOrm);
        tx.validateReference(refDomain);

        const existingReversal = await txEm.findOne(WagerTransactionOrmEntity, {
          referenceTransactionId: refDomain.id,
          status: WagerTransactionStatus.Processed,
          kind: {
            $in: [
              WagerTransactionKind.Refund,
              WagerTransactionKind.Rollback,
            ],
          },
        });

        if (existingReversal) {
          throw new BusinessRuleViolationError(
            `Reference '${refDomain.externalTransactionId}' already reversed`,
            FailureCode.ReferenceAlreadyReversed,
          );
        }

        const direction = tx.ledgerDirectionFor(refDomain);
        const ledgerEntry =
          direction === LedgerDirection.Debit
            ? wallet.debit({
                entryId: randomUUID(),
                transactionId: tx.id,
                amount: tx.money,
                occurredAt: now,
                isReversal: tx.kind === WagerTransactionKind.Rollback,
              })
            : wallet.credit({
                entryId: randomUUID(),
                transactionId: tx.id,
                amount: tx.money,
                occurredAt: now,
              });

        tx.markProcessed(refDomain.id, now, wallet.balance);

        WalletMapper.toPersistence(wallet, walletOrm);
        WagerTransactionMapper.toPersistence(tx, txOrm);
        txEm.persist(WalletLedgerEntryMapper.toPersistence(ledgerEntry));

        const processedEvent = WagerTransactionProcessed.from(
          tx,
          wallet.balance.toJSON(),
          {
            correlationId,
            occurredAt: now,
          },
        );
        const balanceEvent = WalletBalanceChanged.from(wallet, ledgerEntry, {
          correlationId,
          occurredAt: now,
        });

        txEm.persist(
          OutboxMessageMapper.toPersistence(
            OutboxMessage.enqueue(processedEvent),
          ),
        );
        txEm.persist(
          OutboxMessageMapper.toPersistence(
            OutboxMessage.enqueue(balanceEvent),
          ),
        );

        await txEm.flush();

        this.metrics.recordTransactionStatus(
          WagerTransactionStatus.Processed,
          tx.kind,
        );
        this.logger.info(
          "Out-of-order PENDING_REFERENCE transaction resolved and processed",
          {
            event: "pending_reference_processed",
            correlationId,
            transactionId: tx.id,
            walletId: tx.walletId,
            providerId: tx.providerId,
            status: tx.status,
          },
        );
        return "PROCESSED";
      } catch (err: unknown) {
        if (
          err instanceof BusinessRuleViolationError ||
          err instanceof CurrencyMismatchError
        ) {
          const failureCode =
            err instanceof BusinessRuleViolationError
              ? err.failureCode
              : FailureCode.CurrencyMismatch;

          tx.reject(failureCode, now, wallet.balance);
          WagerTransactionMapper.toPersistence(tx, txOrm);

          const rejectedEvent = WagerTransactionRejected.from(tx, {
            correlationId,
            occurredAt: now,
          });
          txEm.persist(
            OutboxMessageMapper.toPersistence(
              OutboxMessage.enqueue(rejectedEvent),
            ),
          );
          await txEm.flush();

          this.metrics.recordTransactionStatus(
            WagerTransactionStatus.Rejected,
            tx.kind,
            failureCode,
          );
          return "REJECTED";
        }
        throw err;
      }
    });
  }
}

