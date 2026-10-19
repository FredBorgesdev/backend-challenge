import { randomUUID } from "node:crypto";
import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/integration-events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  BusinessRuleViolationError,
  CurrencyMismatchError,
  IdempotencyConflictError,
  InvalidDomainValidationError,
  ResourceNotFoundError,
  TransientInfrastructureError,
} from "../../domain/shared/domain-error";
import { Money, MoneyProps } from "../../domain/shared/money";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/enums";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { StructuredLoggerService } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import {
  InboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from "../../infrastructure/persistence/entities/orm-entities";
import {
  InboxMessageMapper,
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../../infrastructure/persistence/mappers/domain-mappers";

export interface InboxExecutionContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: InboxExecutionContext;
}

export interface SubmitWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  async execute(
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionOutput> {
    const startTime = performance.now();
    const correlationId = input.correlationId ?? randomUUID();

    this.validateInputShape(input);

    const money = Money.from(input.money);
    const candidateTx = WagerTransaction.create({
      id: randomUUID(),
      providerId: input.providerId.trim(),
      externalTransactionId: input.externalTransactionId.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      walletId: input.walletId.trim(),
      playerId: input.playerId.trim(),
      roundId: input.roundId.trim(),
      gameId: input.gameId.trim(),
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    const maxRetries = 4;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeTransactionalAttempt(
          candidateTx,
          correlationId,
          input.inboxContext,
        );
        const durationMs = performance.now() - startTime;
        this.metrics.recordProcessingLatency(durationMs);
        return result;
      } catch (err: unknown) {
        if (this.isUniqueConstraintViolation(err)) {
          // Concurrent duplicate request just committed; resolve idempotently
          this.metrics.incrementLockConflict();
          const replay = await this.resolveExistingTransactionAfterRace(
            candidateTx,
            input.inboxContext,
          );
          if (replay) {
            const durationMs = performance.now() - startTime;
            this.metrics.recordProcessingLatency(durationMs);
            return replay;
          }
        }

        if (this.isRetryablePostgresError(err) && attempt < maxRetries) {
          this.metrics.incrementLockConflict();
          this.metrics.incrementRetry("dbSerialization");
          await this.sleep(15 * Math.pow(2, attempt - 1));
          continue;
        }

        if (this.isTransientDatabaseError(err)) {
          throw new TransientInfrastructureError(
            (err as Error).message ?? "Database temporarily unavailable",
          );
        }

        throw err;
      }
    }

    throw new TransientInfrastructureError(
      "Exceeded maximum transaction retries due to concurrency contention",
    );
  }

  private async executeTransactionalAttempt(
    candidateTx: WagerTransaction,
    correlationId: string,
    inboxContext?: InboxExecutionContext,
  ): Promise<SubmitWagerTransactionOutput> {
    return this.em.fork().transactional(async (txEm) => {
      const now = new Date();

      // 1. Se veio do SQS, verificar/registrar InboxMessage na mesma transação
      let inboxOrm: InboxMessageOrmEntity | null = null;
      if (inboxContext) {
        inboxOrm = await txEm.findOne(
          InboxMessageOrmEntity,
          {
            consumerName: inboxContext.consumerName,
            messageId: inboxContext.messageId,
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (inboxOrm && inboxOrm.processedAt) {
          this.metrics.incrementDuplicateDetected();
          const existingByIdem = await txEm.findOne(WagerTransactionOrmEntity, {
            $or: [
              { idempotencyKey: candidateTx.idempotencyKey },
              {
                providerId: candidateTx.providerId,
                externalTransactionId: candidateTx.externalTransactionId,
              },
            ],
          });
          if (existingByIdem) {
            const existingDomain =
              WagerTransactionMapper.toDomain(existingByIdem);
            const walletOrm = await txEm.findOne(WalletOrmEntity, {
              id: existingDomain.walletId,
            });
            const fallbackBalance = walletOrm
              ? WalletMapper.toDomain(walletOrm).balance
              : existingDomain.money;
            return {
              transactionId: existingDomain.id,
              status: existingDomain.status,
              balance: (
                existingDomain.observedBalance ?? fallbackBalance
              ).toJSON(),
              failureCode: existingDomain.failureCode,
              idempotentReplay: true,
            };
          }
        }

        if (!inboxOrm) {
          const newInbox = InboxMessage.receive({
            consumerName: inboxContext.consumerName,
            messageId: inboxContext.messageId,
            payloadHash: inboxContext.payloadHash,
            receivedAt: now,
          });
          inboxOrm = InboxMessageMapper.toPersistence(newInbox);
          txEm.persist(inboxOrm);
        }
      }

      // 2. Verificar se já existe transação por idempotencyKey ou (providerId, externalTransactionId)
      // antes do lock da wallet (para detectar conflito mesmo se walletId for inválido/diferente)
      const preExistingOrm = await txEm.findOne(WagerTransactionOrmEntity, {
        $or: [
          { idempotencyKey: candidateTx.idempotencyKey },
          {
            providerId: candidateTx.providerId,
            externalTransactionId: candidateTx.externalTransactionId,
          },
        ],
      });

      if (preExistingOrm) {
        return this.handleExistingTransaction(
          txEm,
          preExistingOrm,
          candidateTx,
          inboxOrm,
          now,
          correlationId,
        );
      }

      // 3. Adquirir Pessimistic Write Lock (SELECT ... FOR UPDATE) na Wallet
      // Isso serializa todas as operações concorrentes da mesma walletId!
      const walletOrm = await txEm.findOne(
        WalletOrmEntity,
        { id: candidateTx.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletOrm) {
        throw new ResourceNotFoundError(
          "Wallet",
          candidateTx.walletId,
          "WALLET_NOT_FOUND",
        );
      }

      // 4. Re-verificar idempotência APÓS adquirir o lock da Wallet!
      // Se 50 requisições idênticas disputaram o lock da mesma wallet, as 49 que entrarem
      // após o commit da 1ª verão a transação já gravada aqui em READ COMMITTED!
      const postLockExistingOrm = await txEm.findOne(
        WagerTransactionOrmEntity,
        {
          $or: [
            { idempotencyKey: candidateTx.idempotencyKey },
            {
              providerId: candidateTx.providerId,
              externalTransactionId: candidateTx.externalTransactionId,
            },
          ],
        },
      );

      if (postLockExistingOrm) {
        return this.handleExistingTransaction(
          txEm,
          postLockExistingOrm,
          candidateTx,
          inboxOrm,
          now,
          correlationId,
        );
      }

      const wallet = WalletMapper.toDomain(walletOrm);
      const tx = WagerTransaction.rehydrate({
        id: candidateTx.id,
        providerId: candidateTx.providerId,
        externalTransactionId: candidateTx.externalTransactionId,
        idempotencyKey: candidateTx.idempotencyKey,
        payloadHash: candidateTx.payloadHash,
        walletId: candidateTx.walletId,
        playerId: candidateTx.playerId,
        roundId: candidateTx.roundId,
        gameId: candidateTx.gameId,
        kind: candidateTx.kind,
        money: candidateTx.money,
        referenceExternalTransactionId:
          candidateTx.referenceExternalTransactionId,
        createdAt: now,
        status: WagerTransactionStatus.Pending,
      });

      // 5. Executar regras de negócio e aplicar movimentação
      try {
        if (wallet.playerId !== tx.playerId) {
          throw new BusinessRuleViolationError(
            `Wallet ${wallet.id} does not belong to player ${tx.playerId}`,
            FailureCode.ReferenceContextMismatch,
          );
        }

        if (wallet.currency !== tx.money.currency) {
          throw new CurrencyMismatchError(wallet.currency, tx.money.currency);
        }

        let referenceDomain: WagerTransaction | undefined;

        if (
          tx.requiresReference() ||
          (tx.kind === WagerTransactionKind.Win &&
            tx.referenceExternalTransactionId)
        ) {
          const refOrm = await txEm.findOne(
            WagerTransactionOrmEntity,
            {
              providerId: tx.providerId,
              externalTransactionId: tx.referenceExternalTransactionId!,
            },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );

          if (!refOrm) {
            if (tx.requiresReference()) {
              tx.markPendingReference(now);
              const txOrm = WagerTransactionMapper.toPersistence(tx);
              txOrm.observedBalanceAmount = wallet.balance.amount;
              txEm.persist(txOrm);

              const pendingEvent = WagerTransactionPendingReference.from(tx, {
                correlationId,
                causationId: inboxContext?.messageId,
                occurredAt: now,
              });
              txEm.persist(
                OutboxMessageMapper.toPersistence(
                  OutboxMessage.enqueue(pendingEvent),
                ),
              );

              if (inboxOrm) {
                inboxOrm.processedAt = now;
              }

              await txEm.flush();

              this.metrics.recordTransactionStatus(
                WagerTransactionStatus.PendingReference,
                tx.kind,
              );
              this.logger.info("Transaction parked in PENDING_REFERENCE", {
                event: "wager_transaction_pending_reference",
                correlationId,
                messageId: inboxContext?.messageId,
                transactionId: tx.id,
                walletId: tx.walletId,
                providerId: tx.providerId,
                status: tx.status,
              });

              return {
                transactionId: tx.id,
                status: WagerTransactionStatus.PendingReference,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            } else {
              throw new BusinessRuleViolationError(
                `Referenced BET '${tx.referenceExternalTransactionId}' not found for WIN`,
                FailureCode.ReferenceNotFound,
              );
            }
          }

          referenceDomain = WagerTransactionMapper.toDomain(refOrm);
          tx.validateReference(referenceDomain);

          if (tx.requiresReference()) {
            const existingReversal = await txEm.findOne(
              WagerTransactionOrmEntity,
              {
                referenceTransactionId: referenceDomain.id,
                status: WagerTransactionStatus.Processed,
                kind: {
                  $in: [
                    WagerTransactionKind.Refund,
                    WagerTransactionKind.Rollback,
                  ],
                },
              },
            );

            if (existingReversal) {
              throw new BusinessRuleViolationError(
                `Referenced transaction '${referenceDomain.externalTransactionId}' was already reversed`,
                FailureCode.ReferenceAlreadyReversed,
              );
            }
          }
        }

        // Aplicar efeito no saldo quando aplicável (BET, WIN, REFUND, ROLLBACK)
        let ledgerEntry;
        if (tx.affectsBalance()) {
          const direction = tx.ledgerDirectionFor(referenceDomain);
          if (direction === LedgerDirection.Debit) {
            ledgerEntry = wallet.debit({
              entryId: randomUUID(),
              transactionId: tx.id,
              amount: tx.money,
              occurredAt: now,
              isReversal: tx.kind === WagerTransactionKind.Rollback,
            });
          } else {
            ledgerEntry = wallet.credit({
              entryId: randomUUID(),
              transactionId: tx.id,
              amount: tx.money,
              occurredAt: now,
            });
          }
        }

        tx.markProcessed(referenceDomain?.id, now, wallet.balance);

        // Persistir Wallet (se mudou), WagerTransaction, WalletLedgerEntry e OutboxMessages na mesma transação SQL
        WalletMapper.toPersistence(wallet, walletOrm);
        txEm.persist(WagerTransactionMapper.toPersistence(tx));
        await txEm.flush();

        const processedEvent = WagerTransactionProcessed.from(
          tx,
          wallet.balance.toJSON(),
          {
            correlationId,
            causationId: inboxContext?.messageId,
            occurredAt: now,
          },
        );
        txEm.persist(
          OutboxMessageMapper.toPersistence(
            OutboxMessage.enqueue(processedEvent),
          ),
        );

        if (ledgerEntry) {
          txEm.persist(WalletLedgerEntryMapper.toPersistence(ledgerEntry));
          const balanceChangedEvent = WalletBalanceChanged.from(
            wallet,
            ledgerEntry,
            {
              correlationId,
              causationId: inboxContext?.messageId,
              occurredAt: now,
            },
          );
          txEm.persist(
            OutboxMessageMapper.toPersistence(
              OutboxMessage.enqueue(balanceChangedEvent),
            ),
          );
        }

        if (inboxOrm) {
          inboxOrm.processedAt = now;
        }

        await txEm.flush();

        this.metrics.recordTransactionStatus(
          WagerTransactionStatus.Processed,
          tx.kind,
        );
        this.logger.info("Wager transaction processed", {
          event: "wager_transaction_processed",
          correlationId,
          messageId: inboxContext?.messageId,
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          status: tx.status,
        });

        return {
          transactionId: tx.id,
          status: WagerTransactionStatus.Processed,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
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
          txEm.persist(WagerTransactionMapper.toPersistence(tx));

          const rejectedEvent = WagerTransactionRejected.from(tx, {
            correlationId,
            causationId: inboxContext?.messageId,
            occurredAt: now,
          });
          txEm.persist(
            OutboxMessageMapper.toPersistence(
              OutboxMessage.enqueue(rejectedEvent),
            ),
          );

          if (inboxOrm) {
            inboxOrm.processedAt = now;
          }

          await txEm.flush();

          this.metrics.recordTransactionStatus(
            WagerTransactionStatus.Rejected,
            tx.kind,
            failureCode,
          );
          this.logger.warn("Wager transaction rejected by business rule", {
            event: "wager_transaction_rejected",
            correlationId,
            messageId: inboxContext?.messageId,
            transactionId: tx.id,
            walletId: tx.walletId,
            providerId: tx.providerId,
            status: tx.status,
            failureCode,
          });

          return {
            transactionId: tx.id,
            status: WagerTransactionStatus.Rejected,
            balance: wallet.balance.toJSON(),
            failureCode,
            idempotentReplay: false,
          };
        }

        throw err;
      }
    });
  }

  private async handleExistingTransaction(
    txEm: EntityManager,
    existingOrm: WagerTransactionOrmEntity,
    candidateTx: WagerTransaction,
    inboxOrm: InboxMessageOrmEntity | null,
    now: Date,
    correlationId: string,
  ): Promise<SubmitWagerTransactionOutput> {
    const existingDomain = WagerTransactionMapper.toDomain(existingOrm);

    const isSameIdentity =
      existingDomain.idempotencyKey === candidateTx.idempotencyKey &&
      existingDomain.providerId === candidateTx.providerId &&
      existingDomain.externalTransactionId ===
        candidateTx.externalTransactionId &&
      existingDomain.matchesPayload(candidateTx.payloadHash);

    if (!isSameIdentity) {
      this.metrics.incrementIdempotencyConflict();
      this.logger.warn("Idempotency conflict detected", {
        event: "idempotency_conflict",
        correlationId,
        transactionId: existingDomain.id,
        walletId: candidateTx.walletId,
        providerId: candidateTx.providerId,
      });
      throw new IdempotencyConflictError(candidateTx.idempotencyKey);
    }

    if (inboxOrm && !inboxOrm.processedAt) {
      inboxOrm.processedAt = now;
      await txEm.flush();
    }

    this.metrics.incrementDuplicateDetected();

    let observedBalance = existingDomain.observedBalance;
    if (!observedBalance) {
      const walletOrm = await txEm.findOne(WalletOrmEntity, {
        id: existingDomain.walletId,
      });
      observedBalance = walletOrm
        ? WalletMapper.toDomain(walletOrm).balance
        : existingDomain.money;
    }

    this.logger.info("Idempotent replay returned", {
      event: "wager_transaction_idempotent_replay",
      correlationId,
      transactionId: existingDomain.id,
      walletId: existingDomain.walletId,
      providerId: existingDomain.providerId,
      status: existingDomain.status,
    });

    return {
      transactionId: existingDomain.id,
      status: existingDomain.status,
      balance: observedBalance.toJSON(),
      failureCode: existingDomain.failureCode,
      idempotentReplay: true,
    };
  }

  private async resolveExistingTransactionAfterRace(
    candidateTx: WagerTransaction,
    inboxContext?: InboxExecutionContext,
  ): Promise<SubmitWagerTransactionOutput | null> {
    const fork = this.em.fork();
    const existingOrm = await fork.findOne(WagerTransactionOrmEntity, {
      $or: [
        { idempotencyKey: candidateTx.idempotencyKey },
        {
          providerId: candidateTx.providerId,
          externalTransactionId: candidateTx.externalTransactionId,
        },
      ],
    });
    if (!existingOrm) {
      return null;
    }

    const existingDomain = WagerTransactionMapper.toDomain(existingOrm);
    const isSameIdentity =
      existingDomain.idempotencyKey === candidateTx.idempotencyKey &&
      existingDomain.providerId === candidateTx.providerId &&
      existingDomain.externalTransactionId ===
        candidateTx.externalTransactionId &&
      existingDomain.matchesPayload(candidateTx.payloadHash);

    if (!isSameIdentity) {
      this.metrics.incrementIdempotencyConflict();
      throw new IdempotencyConflictError(candidateTx.idempotencyKey);
    }

    if (inboxContext) {
      await fork.transactional(async (txEm) => {
        const inbox = await txEm.findOne(InboxMessageOrmEntity, {
          consumerName: inboxContext.consumerName,
          messageId: inboxContext.messageId,
        });
        if (inbox && !inbox.processedAt) {
          inbox.processedAt = new Date();
        } else if (!inbox) {
          const created = InboxMessage.receive({
            consumerName: inboxContext.consumerName,
            messageId: inboxContext.messageId,
            payloadHash: inboxContext.payloadHash,
            receivedAt: new Date(),
          });
          created.markProcessed(new Date());
          txEm.persist(InboxMessageMapper.toPersistence(created));
        }
        await txEm.flush();
      });
    }

    this.metrics.incrementDuplicateDetected();
    return {
      transactionId: existingDomain.id,
      status: existingDomain.status,
      balance: (existingDomain.observedBalance ?? existingDomain.money).toJSON(),
      failureCode: existingDomain.failureCode,
      idempotentReplay: true,
    };
  }

  private validateInputShape(input: SubmitWagerTransactionInput): void {
    if (!input || typeof input !== "object") {
      throw new InvalidDomainValidationError("Request body must be an object");
    }
    if (
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.trim().length === 0
    ) {
      throw new InvalidDomainValidationError(
        "Idempotency-Key header is required",
        "MISSING_IDEMPOTENCY_KEY",
      );
    }
    if (
      typeof input.walletId !== "string" ||
      !UUID_REGEX.test(input.walletId.trim())
    ) {
      throw new InvalidDomainValidationError("walletId must be a valid UUID");
    }
    const validKinds = new Set<string>([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]);
    if (!validKinds.has(input.kind)) {
      throw new InvalidDomainValidationError(
        `Invalid or forbidden transaction kind: '${String(input.kind)}'`,
      );
    }
  }

  private isUniqueConstraintViolation(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const anyErr = err as { code?: string; cause?: { code?: string }; message?: string };
    return (
      anyErr.code === "23505" ||
      anyErr.cause?.code === "23505" ||
      Boolean(anyErr.message?.includes("duplicate key value violates unique constraint"))
    );
  }

  private isRetryablePostgresError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const anyErr = err as { code?: string; cause?: { code?: string } };
    const code = anyErr.code ?? anyErr.cause?.code;
    // 40001 = serialization_failure, 40P01 = deadlock_detected, 55P03 = lock_not_available
    return code === "40001" || code === "40P01" || code === "55P03";
  }

  private isTransientDatabaseError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const anyErr = err as { code?: string; cause?: { code?: string }; message?: string };
    const code = anyErr.code ?? anyErr.cause?.code ?? "";
    return (
      code.startsWith("08") ||
      code === "57P01" ||
      code === "53300" ||
      Boolean(anyErr.message?.includes("ECONNREFUSED")) ||
      Boolean(anyErr.message?.includes("Connection terminated"))
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
