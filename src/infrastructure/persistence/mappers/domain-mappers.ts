import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { Money } from "../../../domain/shared/money";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/enums";
import { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { Wallet } from "../../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import {
  InboxMessageOrmEntity,
  OutboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../entities/orm-entities";

export class WalletMapper {
  static toDomain(orm: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: orm.id,
      playerId: orm.playerId,
      currency: orm.currency,
      balance: Money.rehydrate({
        amount: orm.balanceAmount,
        currency: orm.currency,
      }),
      version: Number(orm.version),
      createdAt: new Date(orm.createdAt),
      updatedAt: new Date(orm.updatedAt),
    });
  }

  static toPersistence(domain: Wallet, target?: WalletOrmEntity): WalletOrmEntity {
    const orm = target ?? new WalletOrmEntity();
    orm.id = domain.id;
    orm.playerId = domain.playerId;
    orm.currency = domain.currency;
    orm.balanceAmount = domain.balance.amount;
    orm.version = domain.version;
    orm.createdAt = domain.createdAt;
    orm.updatedAt = domain.updatedAt;
    return orm;
  }
}

export class WagerTransactionMapper {
  static toDomain(orm: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: orm.id,
      providerId: orm.providerId,
      externalTransactionId: orm.externalTransactionId,
      idempotencyKey: orm.idempotencyKey,
      payloadHash: orm.payloadHash,
      walletId: orm.walletId,
      playerId: orm.playerId,
      roundId: orm.roundId,
      gameId: orm.gameId,
      kind: orm.kind as WagerTransactionKind,
      money: Money.rehydrate({
        amount: orm.amount,
        currency: orm.currency,
      }),
      referenceExternalTransactionId:
        orm.referenceExternalTransactionId ?? undefined,
      createdAt: new Date(orm.createdAt),
      status: orm.status as WagerTransactionStatus,
      referenceTransactionId: orm.referenceTransactionId ?? undefined,
      failureCode: (orm.failureCode as FailureCode) ?? undefined,
      processedAt: orm.processedAt ? new Date(orm.processedAt) : undefined,
      observedBalance: orm.observedBalanceAmount
        ? Money.rehydrate({
            amount: orm.observedBalanceAmount,
            currency: orm.currency,
          })
        : undefined,
      retryCount: Number(orm.retryCount ?? 0),
      nextRetryAt: orm.nextRetryAt ? new Date(orm.nextRetryAt) : undefined,
    });
  }

  static toPersistence(
    domain: WagerTransaction,
    target?: WagerTransactionOrmEntity,
  ): WagerTransactionOrmEntity {
    const orm = target ?? new WagerTransactionOrmEntity();
    orm.id = domain.id;
    orm.providerId = domain.providerId;
    orm.externalTransactionId = domain.externalTransactionId;
    orm.idempotencyKey = domain.idempotencyKey;
    orm.payloadHash = domain.payloadHash;
    orm.walletId = domain.walletId;
    orm.playerId = domain.playerId;
    orm.roundId = domain.roundId;
    orm.gameId = domain.gameId;
    orm.kind = domain.kind;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.referenceExternalTransactionId =
      domain.referenceExternalTransactionId ?? null;
    orm.status = domain.status;
    orm.referenceTransactionId = domain.referenceTransactionId ?? null;
    orm.failureCode = domain.failureCode ?? null;
    orm.observedBalanceAmount = domain.observedBalance
      ? domain.observedBalance.amount
      : null;
    orm.retryCount = domain.retryCount;
    orm.nextRetryAt = domain.nextRetryAt ?? null;
    orm.createdAt = domain.createdAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }
}

export class WalletLedgerEntryMapper {
  static toDomain(orm: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: orm.id,
      walletId: orm.walletId,
      transactionId: orm.transactionId,
      direction: orm.direction as LedgerDirection,
      money: Money.rehydrate({
        amount: orm.amount,
        currency: orm.currency,
      }),
      balanceBefore: Money.rehydrate({
        amount: orm.balanceBefore,
        currency: orm.currency,
      }),
      balanceAfter: Money.rehydrate({
        amount: orm.balanceAfter,
        currency: orm.currency,
      }),
      createdAt: new Date(orm.createdAt),
    });
  }

  static toPersistence(
    domain: WalletLedgerEntry,
  ): WalletLedgerEntryOrmEntity {
    const orm = new WalletLedgerEntryOrmEntity();
    orm.id = domain.id;
    orm.walletId = domain.walletId;
    orm.transactionId = domain.transactionId;
    orm.direction = domain.direction;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.balanceBefore = domain.balanceBefore.amount;
    orm.balanceAfter = domain.balanceAfter.amount;
    orm.createdAt = domain.createdAt;
    return orm;
  }
}

export class InboxMessageMapper {
  static toDomain(orm: InboxMessageOrmEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: orm.consumerName,
      messageId: orm.messageId,
      payloadHash: orm.payloadHash,
      receivedAt: new Date(orm.receivedAt),
      processedAt: orm.processedAt ? new Date(orm.processedAt) : undefined,
    });
  }

  static toPersistence(
    domain: InboxMessage,
    target?: InboxMessageOrmEntity,
  ): InboxMessageOrmEntity {
    const orm = target ?? new InboxMessageOrmEntity();
    orm.consumerName = domain.consumerName;
    orm.messageId = domain.messageId;
    orm.payloadHash = domain.payloadHash;
    orm.receivedAt = domain.receivedAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }
}

export class OutboxMessageMapper {
  static toDomain(orm: OutboxMessageOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: orm.id,
      aggregateId: orm.aggregateId,
      eventType: orm.eventType,
      payload: orm.payload,
      occurredAt: new Date(orm.occurredAt),
      attempts: Number(orm.attempts),
      nextAttemptAt: orm.nextAttemptAt
        ? new Date(orm.nextAttemptAt)
        : undefined,
      publishedAt: orm.publishedAt ? new Date(orm.publishedAt) : undefined,
    });
  }

  static toPersistence(
    domain: OutboxMessage,
    target?: OutboxMessageOrmEntity,
  ): OutboxMessageOrmEntity {
    const orm = target ?? new OutboxMessageOrmEntity();
    orm.id = domain.id;
    orm.aggregateId = domain.aggregateId;
    orm.eventType = domain.eventType;
    orm.payload = { ...domain.payload };
    orm.occurredAt = domain.occurredAt;
    orm.attempts = domain.attempts;
    orm.nextAttemptAt = domain.nextAttemptAt ?? null;
    orm.publishedAt = domain.publishedAt ?? null;
    return orm;
  }
}

