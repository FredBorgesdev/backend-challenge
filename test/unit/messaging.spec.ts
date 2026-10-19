import { describe, expect, it } from "bun:test";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../src/domain/messaging/integration-events";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/shared/money";
import { WagerTransactionKind } from "../../src/domain/wagering/enums";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";

describe("InboxMessage, OutboxMessage & IntegrationEvents", () => {
  it("manages InboxMessage lifecycle", () => {
    const inbox = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "sqs-wager-consumer",
      payloadHash: "hash-123",
    });

    expect(inbox.isProcessed()).toBe(false);
    const now = new Date();
    inbox.markProcessed(now);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(now);
  });

  it("serializes IntegrationEvent with MoneyProps and manages OutboxMessage retries", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const entry = wallet.debit({
      entryId: "entry-1",
      transactionId: "tx-1",
      amount: Money.from({ amount: "25.00", currency: "BRL" }),
    });

    const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
      correlationId: "corr-1",
      causationId: "msg-1",
    });

    const json = balanceEvent.toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(json.data.balanceBefore).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
    expect(json.data.balanceAfter).toEqual({
      amount: "75.00",
      currency: "BRL",
    });
    expect(json.data.walletVersion).toBe(2);

    const outbox = OutboxMessage.enqueue(balanceEvent);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(new Date())).toBe(true);

    const retryBase = new Date();
    outbox.scheduleRetry(retryBase);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(retryBase)).toBe(false);

    const pubTime = new Date(retryBase.getTime() + 1000);
    outbox.markPublished(pubTime);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.publishedAt).toEqual(pubTime);
  });

  it("creates WagerTransactionProcessed integration event", () => {
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });
    tx.markProcessed(undefined, new Date());

    const ev = WagerTransactionProcessed.from(
      tx,
      { amount: "75.00", currency: "BRL" },
      { correlationId: "corr-1" },
    );
    expect(ev.eventType).toBe("WagerTransactionProcessed");
    expect(ev.toJSON().data.balance).toEqual({
      amount: "75.00",
      currency: "BRL",
    });
  });
});

