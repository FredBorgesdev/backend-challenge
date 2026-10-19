import { EntitySchema } from "@mikro-orm/core";
import {
  InboxMessageOrmEntity,
  OutboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../entities/orm-entities";

export const WalletSchema = new EntitySchema<WalletOrmEntity>({
  class: WalletOrmEntity,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    currency: { type: "string", length: 3 },
    balanceAmount: {
      type: "decimal",
      fieldName: "balance_amount",
      precision: 18,
      scale: 2,
    },
    version: { type: "integer", default: 1 },
    createdAt: { type: "Date", fieldName: "created_at" },
    updatedAt: { type: "Date", fieldName: "updated_at" },
  },
});

export const WagerTransactionSchema =
  new EntitySchema<WagerTransactionOrmEntity>({
    class: WagerTransactionOrmEntity,
    tableName: "wager_transactions",
    properties: {
      id: { type: "uuid", primary: true },
      providerId: { type: "string", fieldName: "provider_id", length: 128 },
      externalTransactionId: {
        type: "string",
        fieldName: "external_transaction_id",
        length: 128,
      },
      idempotencyKey: {
        type: "string",
        fieldName: "idempotency_key",
        length: 255,
      },
      payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
      walletId: { type: "uuid", fieldName: "wallet_id" },
      playerId: { type: "string", fieldName: "player_id", length: 128 },
      roundId: { type: "string", fieldName: "round_id", length: 128 },
      gameId: { type: "string", fieldName: "game_id", length: 128 },
      kind: { type: "string", length: 32 },
      amount: { type: "decimal", precision: 18, scale: 2 },
      currency: { type: "string", length: 3 },
      referenceExternalTransactionId: {
        type: "string",
        fieldName: "reference_external_transaction_id",
        length: 128,
        nullable: true,
      },
      status: { type: "string", length: 32 },
      referenceTransactionId: {
        type: "uuid",
        fieldName: "reference_transaction_id",
        nullable: true,
      },
      failureCode: {
        type: "string",
        fieldName: "failure_code",
        length: 64,
        nullable: true,
      },
      observedBalanceAmount: {
        type: "decimal",
        fieldName: "observed_balance_amount",
        precision: 18,
        scale: 2,
        nullable: true,
      },
      retryCount: { type: "integer", fieldName: "retry_count", default: 0 },
      nextRetryAt: {
        type: "Date",
        fieldName: "next_retry_at",
        nullable: true,
      },
      createdAt: { type: "Date", fieldName: "created_at" },
      processedAt: {
        type: "Date",
        fieldName: "processed_at",
        nullable: true,
      },
    },
  });

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryOrmEntity>({
    class: WalletLedgerEntryOrmEntity,
    tableName: "wallet_ledger_entries",
    properties: {
      id: { type: "uuid", primary: true },
      walletId: { type: "uuid", fieldName: "wallet_id" },
      transactionId: { type: "uuid", fieldName: "transaction_id" },
      direction: { type: "string", length: 16 },
      amount: { type: "decimal", precision: 18, scale: 2 },
      currency: { type: "string", length: 3 },
      balanceBefore: {
        type: "decimal",
        fieldName: "balance_before",
        precision: 18,
        scale: 2,
      },
      balanceAfter: {
        type: "decimal",
        fieldName: "balance_after",
        precision: 18,
        scale: 2,
      },
      createdAt: { type: "Date", fieldName: "created_at" },
      sequenceNumber: {
        type: "bigint",
        fieldName: "sequence_number",
        persist: false,
        nullable: true,
      },
    },
  });

export const InboxMessageSchema = new EntitySchema<InboxMessageOrmEntity>({
  class: InboxMessageOrmEntity,
  tableName: "inbox_messages",
  properties: {
    consumerName: {
      type: "string",
      fieldName: "consumer_name",
      length: 128,
      primary: true,
    },
    messageId: {
      type: "string",
      fieldName: "message_id",
      length: 128,
      primary: true,
    },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    receivedAt: { type: "Date", fieldName: "received_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageOrmEntity>({
  class: OutboxMessageOrmEntity,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id", length: 128 },
    eventType: { type: "string", fieldName: "event_type", length: 128 },
    payload: { type: "json" },
    occurredAt: { type: "Date", fieldName: "occurred_at" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: {
      type: "Date",
      fieldName: "next_attempt_at",
      nullable: true,
    },
    publishedAt: { type: "Date", fieldName: "published_at", nullable: true },
  },
});

export const ALL_ORM_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
