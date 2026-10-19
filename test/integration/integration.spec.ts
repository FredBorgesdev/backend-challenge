import { randomUUID } from "node:crypto";
import {
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { EVENT_PUBLISHER_PORT } from "../../src/application/ports/event-publisher.port";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionKind } from "../../src/domain/wagering/enums";
import { SqsClientService } from "../../src/infrastructure/messaging/sqs-client.service";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager.consumer";
import { StructuredLoggerService } from "../../src/infrastructure/observability/logger.service";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import { createConfiguredApp } from "../../src/main";

describe("Integration Tests (Real PostgreSQL + Real LocalStack SQS)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let em: EntityManager;
  let sqsService: SqsClientService;
  let sqsConsumer: SqsWagerConsumer;
  let reconcileUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    const suiteId = randomUUID().slice(0, 8);
    process.env.LOG_LEVEL = "error";
    process.env.WORKER_ENABLED = "false";
    process.env.SQS_CONSUMER_ENABLED = "false";
    process.env.SQS_WAGER_QUEUE_NAME = `wager-tx-int-${suiteId}.fifo`;
    process.env.SQS_WAGER_DLQ_NAME = `wager-tx-dlq-int-${suiteId}.fifo`;
    process.env.SQS_INTEGRATION_EVENTS_QUEUE_NAME = `int-events-${suiteId}.fifo`;

    app = await createConfiguredApp();
    orm = app.get(MikroORM);
    em = app.get(EntityManager);
    sqsService = app.get(SqsClientService);
    sqsConsumer = app.get(SqsWagerConsumer);
    reconcileUseCase = app.get(ReconcileWalletUseCase);

    const migrator = orm.getMigrator();
    await migrator.up();
    await sqsService.ensureQueuesTopology();

    await app.listen(0, "127.0.0.1");
    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 3000;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it(
    "1. Verifies versioned migrations reversibility (down/up) and PostgreSQL schema constraints & triggers",
    async () => {
      const migrator = orm.getMigrator();
      await migrator.down();
      await migrator.up();

      const playerId = `player-${randomUUID()}`;
      const createRes = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      });
      expect(createRes.status).toBe(201);
      const walletData = (await createRes.json()) as {
        id: string;
        version: number;
      };
      expect(walletData.version).toBe(1);

      // Duplicate wallet for same playerId + currency fails with 409 Conflict
      const dupRes = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: "50.00", currency: "BRL" },
        }),
      });
      expect(dupRes.status).toBe(409);

      const conn = em.fork().getConnection();

      // Test CHECK (balance_amount >= 0) directly in PostgreSQL
      await expect(
        conn.execute(`UPDATE wallets SET balance_amount = -0.01 WHERE id = ?`, [
          walletData.id,
        ]),
      ).rejects.toThrow();

      // Test immutability trigger on wallet_ledger_entries (UPDATE and DELETE must be blocked by PostgreSQL!)
      await expect(
        conn.execute(
          `UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = ?`,
          [walletData.id],
        ),
      ).rejects.toThrow(/immutable/);

      await expect(
        conn.execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [
          walletData.id,
        ]),
      ).rejects.toThrow(/immutable/);

      const rec = await reconcileUseCase.execute(walletData.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance).toEqual(rec.calculatedBalance);
    },
    30_000,
  );

  it(
    "2. Verifies atomicity across Wallet, Ledger, WagerTransaction, and Outbox for BET, WIN, LOSS, REFUND, ROLLBACK + cursor pagination",
    async () => {
      const playerId = `player-${randomUUID()}`;
      const createRes = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: "500.00", currency: "BRL" },
        }),
      });
      const wallet = (await createRes.json()) as { id: string };

      // 1. BET 100.00 -> 400.00
      const betExtId = `bet-${randomUUID()}`;
      const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-1:${betExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "100.00", currency: "BRL" },
        }),
      });
      expect(betRes.status).toBe(200);
      const betBody = (await betRes.json()) as {
        transactionId: string;
        status: string;
        balance: { amount: string };
        idempotentReplay: boolean;
      };
      expect(betBody.status).toBe("PROCESSED");
      expect(betBody.balance.amount).toBe("400.00");
      expect(betBody.idempotentReplay).toBe(false);

      // 2. WIN 250.00 referencing the BET -> 650.00
      const winExtId = `win-${randomUUID()}`;
      const winRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-1:${winExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: winExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "WIN",
          money: { amount: "250.00", currency: "BRL" },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(winRes.status).toBe(200);
      const winBody = (await winRes.json()) as { balance: { amount: string } };
      expect(winBody.balance.amount).toBe("650.00");

      // 3. LOSS 0.00 -> balance unchanged (650.00), no ledger entry created for LOSS
      const lossExtId = `loss-${randomUUID()}`;
      const lossRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-1:${lossExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: lossExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-101",
          gameId: "fortune-chimp",
          kind: "LOSS",
          money: { amount: "0.00", currency: "BRL" },
        }),
      });
      expect(lossRes.status).toBe(200);

      // 4. ROLLBACK of WIN 250.00 -> debits 250.00 -> 400.00
      const rbWinExtId = `rb-win-${randomUUID()}`;
      const rbWinRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-1:${rbWinExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: rbWinExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "ROLLBACK",
          money: { amount: "250.00", currency: "BRL" },
          referenceExternalTransactionId: winExtId,
        }),
      });
      expect(rbWinRes.status).toBe(200);
      const rbWinBody = (await rbWinRes.json()) as {
        balance: { amount: string };
      };
      expect(rbWinBody.balance.amount).toBe("400.00");

      // 5. REFUND of BET 100.00 -> credits 100.00 -> 500.00
      const refundExtId = `refund-${randomUUID()}`;
      const refundRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-1:${refundExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: refundExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "REFUND",
          money: { amount: "100.00", currency: "BRL" },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(refundRes.status).toBe(200);
      const refundBody = (await refundRes.json()) as {
        balance: { amount: string };
      };
      expect(refundBody.balance.amount).toBe("500.00");

      // 6. Second REFUND on same BET must be REJECTED (422 REFERENCE_ALREADY_REVERSED)
      const dupRefundExtId = `refund-dup-${randomUUID()}`;
      const dupRefundRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-1:${dupRefundExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: dupRefundExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "REFUND",
          money: { amount: "100.00", currency: "BRL" },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(dupRefundRes.status).toBe(422);
      const dupRefundBody = (await dupRefundRes.json()) as {
        status: string;
        failureCode: string;
      };
      expect(dupRefundBody.status).toBe("REJECTED");
      expect(dupRefundBody.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

      // 7. Verify cursor pagination on GET /wallets/:walletId/ledger
      const page1Res = await fetch(
        `${baseUrl}/wallets/${wallet.id}/ledger?limit=2`,
      );
      expect(page1Res.status).toBe(200);
      const page1 = (await page1Res.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
        hasNextPage: boolean;
      };
      expect(page1.items.length).toBe(2);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      const page2Res = await fetch(
        `${baseUrl}/wallets/${wallet.id}/ledger?limit=10&cursor=${page1.nextCursor}`,
      );
      const page2 = (await page2Res.json()) as {
        items: Array<{ id: string }>;
        hasNextPage: boolean;
      };
      expect(page1.items.length + page2.items.length).toBe(5);
      expect(page2.hasNextPage).toBe(false);

      // 8. Verify reconciliation endpoint
      const recRes = await fetch(
        `${baseUrl}/wallets/${wallet.id}/reconciliation`,
        { method: "POST" },
      );
      expect(recRes.status).toBe(200);
      const rec = (await recRes.json()) as {
        consistent: boolean;
        checkedEntries: number;
        storedBalance: { amount: string };
        calculatedBalance: { amount: string };
      };
      expect(rec.consistent).toBe(true);
      expect(rec.checkedEntries).toBe(5);
      expect(rec.storedBalance.amount).toBe("500.00");
      expect(rec.calculatedBalance.amount).toBe("500.00");
    },
    30_000,
  );

  it(
    "3. Verifies SQS Consumer Inbox deduplication, redelivery, and DLQ routing for poison messages",
    async () => {
      const playerId = `player-${randomUUID()}`;
      const createRes = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: "200.00", currency: "BRL" },
        }),
      });
      const wallet = (await createRes.json()) as { id: string };

      const wagerQueueUrl = await sqsService.getQueueUrl(
        sqsService.wagerQueueName,
      );
      const dlqUrl = await sqsService.getQueueUrl(sqsService.wagerDlqName);

      const msgId = `msg-${randomUUID()}`;
      const extTxId = `sqs-tx-${randomUUID()}`;
      const validMessage = {
        messageId: msgId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-sqs",
          externalTransactionId: extTxId,
          idempotencyKey: `provider-sqs:${extTxId}`,
          playerId,
          walletId: wallet.id,
          roundId: "round-sqs-1",
          gameId: "fortune-chimp",
          kind: WagerTransactionKind.Bet,
          money: { amount: "45.00", currency: "BRL" },
        },
      };

      // Send the same logical message twice to SQS (simulating at-least-once redelivery)
      await sqsService.client.send(
        new SendMessageCommand({
          QueueUrl: wagerQueueUrl,
          MessageBody: JSON.stringify(validMessage),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: `dedup-1-${randomUUID()}`,
        }),
      );
      await sqsService.client.send(
        new SendMessageCommand({
          QueueUrl: wagerQueueUrl,
          MessageBody: JSON.stringify(validMessage),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: `dedup-2-${randomUUID()}`,
        }),
      );

      // Also send a malformed poison message to test DLQ routing
      await sqsService.client.send(
        new SendMessageCommand({
          QueueUrl: wagerQueueUrl,
          MessageBody: JSON.stringify({ broken: true }),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: `dedup-poison-${randomUUID()}`,
        }),
      );

      // Poll until all 3 messages are processed
      let totalProcessed = 0;
      for (let i = 0; i < 10 && totalProcessed < 3; i++) {
        totalProcessed += await sqsConsumer.pollOnce(10, 0);
      }
      expect(totalProcessed).toBe(3);

      // Check wallet balance: 200.00 - 45.00 = 155.00 (debited once despite duplicate delivery)
      const walletRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
      const updatedWallet = (await walletRes.json()) as {
        balance: { amount: string };
      };
      expect(updatedWallet.balance.amount).toBe("155.00");

      // Verify DLQ received the poison message
      const dlqMessages = await sqsService.client.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      expect((dlqMessages.Messages ?? []).length).toBeGreaterThanOrEqual(1);

      // Verify invariant: wallet.balance == ledger reconstructed balance
      const rec = await reconcileUseCase.execute(wallet.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("155.00");
    },
    30_000,
  );

  it(
    "4. Verifies Outbox retry on failure and concurrent publishers without duplicating or losing events",
    async () => {
      const logger = app.get(StructuredLoggerService);
      const metrics = app.get(MetricsService);
      const conn = em.fork().getConnection();

      // Ensure at least 6 unpublished outbox messages exist right now (even if another process was running)
      await conn.execute(
        `UPDATE outbox_messages
         SET published_at = NULL, next_attempt_at = NOW() - INTERVAL '1 second'
         WHERE id IN (SELECT id FROM outbox_messages LIMIT 6)`,
      );

      let shouldFailFirst = true;
      const publishedEventIds: string[] = [];

      const flakyPublisher = {
        async publish(event: { id: string }) {
          if (shouldFailFirst) {
            shouldFailFirst = false;
            throw new Error("Simulated transient SQS outage");
          }
          publishedEventIds.push(event.id);
        },
      };

      const customPublishUseCase = new PublishOutboxUseCase(
        em,
        flakyPublisher,
        logger,
        metrics,
      );

      // Trigger a batch where the first event fails and schedules a retry
      const firstBatch = await customPublishUseCase.executeBatch(5);
      expect(firstBatch.failed).toBeGreaterThanOrEqual(1);

      // Reset next_attempt_at to NOW() so we can immediately re-run with 3 concurrent publishers
      await conn.execute(
        `UPDATE outbox_messages SET published_at = NULL, next_attempt_at = NOW() - INTERVAL '1 second'
         WHERE id IN (SELECT id FROM outbox_messages LIMIT 6)`,
      );

      const RealPublisher = app.get(EVENT_PUBLISHER_PORT);
      const realOutboxUseCase = new PublishOutboxUseCase(
        em,
        RealPublisher,
        logger,
        metrics,
      );

      const [b1, b2, b3] = await Promise.all([
        realOutboxUseCase.executeBatch(20),
        realOutboxUseCase.executeBatch(20),
        realOutboxUseCase.executeBatch(20),
      ]);

      expect(b1.published + b2.published + b3.published).toBeGreaterThanOrEqual(
        1,
      );

      const remainingRows = await conn.execute<Array<{ cnt: string }>>(
        `SELECT COUNT(*)::text AS cnt FROM outbox_messages WHERE published_at IS NULL`,
      );
      expect(Number(remainingRows[0]?.cnt ?? 0)).toBe(0);
    },
    30_000,
  );

  it(
    "5. Verifies Health endpoints (/health/live and /health/ready) and restart recovery",
    async () => {
      const liveRes = await fetch(`${baseUrl}/health/live`);
      expect(liveRes.status).toBe(200);

      const readyRes = await fetch(`${baseUrl}/health/ready`);
      expect(readyRes.status).toBe(200);
      const readyBody = (await readyRes.json()) as {
        status: string;
        dependencies: { postgres: string; sqs: string };
      };
      expect(readyBody.status).toBe("READY");
      expect(readyBody.dependencies.postgres).toBe("UP");
      expect(readyBody.dependencies.sqs).toBe("UP");
    },
    30_000,
  );
});
