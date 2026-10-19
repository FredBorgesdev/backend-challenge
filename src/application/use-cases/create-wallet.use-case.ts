import { randomUUID } from "node:crypto";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../domain/messaging/integration-events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  InvalidDomainValidationError,
  WalletAlreadyExistsError,
} from "../../domain/shared/domain-error";
import { Money, MoneyProps } from "../../domain/shared/money";
import { LedgerDirection } from "../../domain/wagering/enums";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { StructuredLoggerService } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import {
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../../infrastructure/persistence/mappers/domain-mappers";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    if (
      !input ||
      typeof input.playerId !== "string" ||
      input.playerId.trim().length === 0
    ) {
      throw new InvalidDomainValidationError("playerId is required");
    }

    const playerId = input.playerId.trim();
    const initialMoney = Money.from(input.initialBalance);
    const walletId = randomUUID();
    const correlationId = input.correlationId ?? randomUUID();
    const now = new Date();

    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: initialMoney,
      createdAt: now,
    });

    try {
      await this.em.fork().transactional(async (txEm) => {
        const walletOrm = WalletMapper.toPersistence(wallet);
        txEm.persist(walletOrm);
        await txEm.flush();

        if (initialMoney.isPositive()) {
          const openingTx = WagerTransaction.createOpening({
            id: randomUUID(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialMoney,
            createdAt: now,
          });

          txEm.persist(WagerTransactionMapper.toPersistence(openingTx));
          await txEm.flush();

          const openingLedgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: openingTx.id,
            direction: LedgerDirection.Credit,
            money: initialMoney,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: initialMoney,
            createdAt: now,
          });

          const txProcessedEvent = WagerTransactionProcessed.from(
            openingTx,
            wallet.balance.toJSON(),
            {
              correlationId,
              occurredAt: now,
            },
          );

          const balanceChangedEvent = WalletBalanceChanged.from(
            wallet,
            openingLedgerEntry,
            {
              correlationId,
              occurredAt: now,
            },
          );

          txEm.persist(
            WalletLedgerEntryMapper.toPersistence(openingLedgerEntry),
          );
          txEm.persist(
            OutboxMessageMapper.toPersistence(
              OutboxMessage.enqueue(txProcessedEvent),
            ),
          );
          txEm.persist(
            OutboxMessageMapper.toPersistence(
              OutboxMessage.enqueue(balanceChangedEvent),
            ),
          );
          await txEm.flush();
        }
      });
    } catch (err: unknown) {
      if (this.isUniqueConstraintViolation(err)) {
        throw new WalletAlreadyExistsError(playerId, initialMoney.currency);
      }
      throw err;
    }

    this.logger.info("Wallet created", {
      event: "wallet_created",
      correlationId,
      walletId: wallet.id,
    });

    if (initialMoney.isPositive()) {
      this.metrics.recordTransactionStatus("PROCESSED", "OPENING");
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private isUniqueConstraintViolation(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const anyErr = err as { code?: string; cause?: { code?: string }; message?: string };
    return (
      anyErr.code === "23505" ||
      anyErr.cause?.code === "23505" ||
      Boolean(anyErr.message?.includes("uq_wallets_player_currency"))
    );
  }
}
