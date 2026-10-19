import { randomUUID } from "node:crypto";
import { ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ProcessPendingReferencesUseCase } from "../../src/application/use-cases/process-pending-references.use-case";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionKind } from "../../src/domain/wagering/enums";
import { SqsClientService } from "../../src/infrastructure/messaging/sqs-client.service";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager.consumer";
import { StructuredLoggerService } from "../../src/infrastructure/observability/logger.service";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import { WalletOrmEntity } from "../../src/infrastructure/persistence/entities/orm-entities";
import { createConfiguredApp } from "../../src/main";

async function startInstance(): Promise<{
  app: INestApplication;
  url: string;
}> {
  const app = await createConfiguredApp();
  await app.listen(0, "127.0.0.1");
  const addr = app.getHttpServer().address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { app, url: `http://127.0.0.1:${port}` };
}

describe("Concurrency & Fault-Tolerance Tests (Real Multi-Instance Parallelism)", () => {
  const instances: Array<{ app: INestApplication; url: string }> = [];
  const createdWalletIds = new Set<string>();

  beforeAll(async () => {
    const suiteId = randomUUID().slice(0, 8);
    process.env.LOG_LEVEL = "error";
    process.env.WORKER_ENABLED = "false";
    process.env.SQS_CONSUMER_ENABLED = "false";
    process.env.SQS_WAGER_QUEUE_NAME = `wager-tx-conc-${suiteId}.fifo`;
    process.env.SQS_WAGER_DLQ_NAME = `wager-tx-dlq-conc-${suiteId}.fifo`;
    process.env.SQS_INTEGRATION_EVENTS_QUEUE_NAME = `conc-events-${suiteId}.fifo`;

    // Boot 3 independent application instances simultaneously (Requirement: >= 3 instances)
    const first = await startInstance();
    const orm = first.app.get(MikroORM);
    await orm.getMigrator().up();
    await first.app.get(SqsClientService).ensureQueuesTopology();

    const second = await startInstance();
    const third = await startInstance();
    instances.push(first, second, third);
  }, 30_000);

  afterAll(async () => {
    for (const inst of instances) {
      await inst.app.close().catch(() => undefined);
    }
  });

  async function createWalletOnInstance(
    instanceIdx: number,
    initialAmount: string,
  ): Promise<{ id: string; playerId: string }> {
    const playerId = `player-${randomUUID()}`;
    const res = await fetch(`${instances[instanceIdx]!.url}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: initialAmount, currency: "BRL" },
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string; playerId: string };
    createdWalletIds.add(data.id);
    return data;
  }

  it(
    "1. Same bet sent 50 times in parallel across 3 instances -> exactly 1 debit",
    async () => {
      const wallet = await createWalletOnInstance(0, "500.00");
      const extTxId = `bet-50x-${randomUUID()}`;
      const idempotencyKey = `provider-race:${extTxId}`;

      const requests = Array.from({ length: 50 }, (_, idx) => {
        const targetUrl = instances[idx % instances.length]!.url;
        return fetch(`${targetUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            providerId: "provider-race",
            externalTransactionId: extTxId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-50x",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "30.00", currency: "BRL" },
          }),
        }).then(async (r) => ({
          status: r.status,
          body: (await r.json()) as {
            transactionId: string;
            status: string;
            balance: { amount: string };
            idempotentReplay: boolean;
          },
        }));
      });

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("PROCESSED");
        expect(res.body.balance.amount).toBe("470.00");
      }

      const originalExecutionCount = responses.filter(
        (r) => r.body.idempotentReplay === false,
      ).length;
      const replayCount = responses.filter(
        (r) => r.body.idempotentReplay === true,
      ).length;

      expect(originalExecutionCount).toBe(1);
      expect(replayCount).toBe(49);

      const rec = await instances[0]!.app
        .get(ReconcileWalletUseCase)
        .execute(wallet.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("470.00");
      expect(rec.checkedEntries).toBe(2);
    },
    30_000,
  );

  it(
    "2. Double-spend prevention: Initial balance 100.00 BRL, two simultaneous 80.00 BRL bets",
    async () => {
      const wallet = await createWalletOnInstance(0, "100.00");

      const bet1Ext = `bet-80-a-${randomUUID()}`;
      const bet2Ext = `bet-80-b-${randomUUID()}`;

      const [resA, resB] = await Promise.all([
        fetch(`${instances[0]!.url}/wagering/transactions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `prov:${bet1Ext}`,
          },
          body: JSON.stringify({
            providerId: "prov",
            externalTransactionId: bet1Ext,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-sec8",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          }),
        }).then(async (r) => ({
          httpStatus: r.status,
          body: (await r.json()) as {
            status: string;
            failureCode?: string;
            balance: { amount: string };
          },
        })),
        fetch(`${instances[1]!.url}/wagering/transactions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `prov:${bet2Ext}`,
          },
          body: JSON.stringify({
            providerId: "prov",
            externalTransactionId: bet2Ext,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-sec8",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          }),
        }).then(async (r) => ({
          httpStatus: r.status,
          body: (await r.json()) as {
            status: string;
            failureCode?: string;
            balance: { amount: string };
          },
        })),
      ]);

      const processed = [resA, resB].filter(
        (r) => r.body.status === "PROCESSED",
      );
      const rejected = [resA, resB].filter(
        (r) => r.body.status === "REJECTED",
      );

      expect(processed.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(processed[0]!.httpStatus).toBe(200);
      expect(rejected[0]!.httpStatus).toBe(422);
      expect(rejected[0]!.body.failureCode).toBe("INSUFFICIENT_FUNDS");

      const retryWinnerExt =
        resA.body.status === "PROCESSED" ? bet1Ext : bet2Ext;
      const retryRes = await fetch(
        `${instances[2]!.url}/wagering/transactions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `prov:${retryWinnerExt}`,
          },
          body: JSON.stringify({
            providerId: "prov",
            externalTransactionId: retryWinnerExt,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-sec8",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          }),
        },
      );
      const retryBody = (await retryRes.json()) as {
        idempotentReplay: boolean;
        balance: { amount: string };
      };
      expect(retryBody.idempotentReplay).toBe(true);
      expect(retryBody.balance.amount).toBe("20.00");

      const rec = await instances[0]!.app
        .get(ReconcileWalletUseCase)
        .execute(wallet.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("20.00");
      expect(rec.calculatedBalance.amount).toBe("20.00");
      expect(rec.checkedEntries).toBe(2);
    },
    30_000,
  );

  it(
    "3. Distinct wallets processed in parallel across >= 3 instances without global lock contention",
    async () => {
      const wallets = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          createWalletOnInstance(i % instances.length, "200.00"),
        ),
      );

      await Promise.all(
        wallets.flatMap((w, wIdx) => [
          fetch(`${instances[wIdx % 3]!.url}/wagering/transactions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `p:${w.id}:bet1`,
            },
            body: JSON.stringify({
              providerId: "p",
              externalTransactionId: `${w.id}:bet1`,
              playerId: w.playerId,
              walletId: w.id,
              roundId: "r1",
              gameId: "g1",
              kind: "BET",
              money: { amount: "50.00", currency: "BRL" },
            }),
          }),
          fetch(`${instances[(wIdx + 1) % 3]!.url}/wagering/transactions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `p:${w.id}:bet2`,
            },
            body: JSON.stringify({
              providerId: "p",
              externalTransactionId: `${w.id}:bet2`,
              playerId: w.playerId,
              walletId: w.id,
              roundId: "r2",
              gameId: "g1",
              kind: "BET",
              money: { amount: "30.00", currency: "BRL" },
            }),
          }),
          fetch(`${instances[(wIdx + 2) % 3]!.url}/wagering/transactions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `p:${w.id}:win1`,
            },
            body: JSON.stringify({
              providerId: "p",
              externalTransactionId: `${w.id}:win1`,
              playerId: w.playerId,
              walletId: w.id,
              roundId: "r1",
              gameId: "g1",
              kind: "WIN",
              money: { amount: "15.00", currency: "BRL" },
            }),
          }),
        ]),
      );

      const reconcileUseCase = instances[0]!.app.get(ReconcileWalletUseCase);
      for (const w of wallets) {
        const rec = await reconcileUseCase.execute(w.id);
        expect(rec.consistent).toBe(true);
        expect(rec.storedBalance.amount).toBe("135.00");
        expect(rec.checkedEntries).toBe(4);
      }
    },
    30_000,
  );

  it(
    "4. Worker killed after DB commit and before SQS ACK -> second instance redelivers without duplicate debit",
    async () => {
      const wallet = await createWalletOnInstance(0, "300.00");
      const sqsService1 = instances[0]!.app.get(SqsClientService);
      const consumer1 = instances[0]!.app.get(SqsWagerConsumer);
      const consumer2 = instances[1]!.app.get(SqsWagerConsumer);

      const queueUrl = await sqsService1.getQueueUrl(
        sqsService1.wagerQueueName,
      );
      const msgId = `crash-msg-${randomUUID()}`;
      const extTxId = `crash-tx-${randomUUID()}`;

      await sqsService1.client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            messageId: msgId,
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            data: {
              providerId: "prov-crash",
              externalTransactionId: extTxId,
              idempotencyKey: `prov-crash:${extTxId}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: "round-crash",
              gameId: "fortune-chimp",
              kind: WagerTransactionKind.Bet,
              money: { amount: "75.00", currency: "BRL" },
            },
          }),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: msgId,
        }),
      );

      const recv1 = await sqsService1.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          AttributeNames: ["All"],
        }),
      );
      const rawMsg = recv1.Messages?.[0];
      expect(rawMsg).toBeDefined();

      // Instance 1 commits the DB transaction and crashes before ACK!
      await expect(
        consumer1.handleRawSqsMessage(queueUrl, rawMsg!, {
          simulateCrashBeforeAck: true,
        }),
      ).rejects.toThrow("SIMULATED_CRASH_AFTER_COMMIT_BEFORE_ACK");

      // Instance 2 picks up the redelivered message and processes it idempotently + ACKs
      await consumer2.pollOnce(10, 1);

      const rec = await instances[2]!.app
        .get(ReconcileWalletUseCase)
        .execute(wallet.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("225.00");
      expect(rec.checkedEntries).toBe(2);
    },
    30_000,
  );

  it(
    "5. Two concurrent publishers over the same Outbox do not collide or duplicate claims (SKIP LOCKED)",
    async () => {
      const em1 = instances[0]!.app.get(EntityManager);
      const em2 = instances[1]!.app.get(EntityManager);
      const logger = instances[0]!.app.get(StructuredLoggerService);
      const metrics = instances[0]!.app.get(MetricsService);

      // Guarantee unpublished outbox rows exist right now before concurrent batch execution
      await em1
        .fork()
        .getConnection()
        .execute(
          `UPDATE outbox_messages
           SET published_at = NULL, next_attempt_at = NOW() - INTERVAL '1 second'
           WHERE id IN (SELECT id FROM outbox_messages LIMIT 20)`,
        );

      const claimedByPub1: string[] = [];
      const claimedByPub2: string[] = [];

      const pub1 = new PublishOutboxUseCase(
        em1,
        {
          async publish(ev) {
            await new Promise((r) => setTimeout(r, 5));
            claimedByPub1.push(ev.id);
          },
        },
        logger,
        metrics,
      );

      const pub2 = new PublishOutboxUseCase(
        em2,
        {
          async publish(ev) {
            await new Promise((r) => setTimeout(r, 5));
            claimedByPub2.push(ev.id);
          },
        },
        logger,
        metrics,
      );

      await Promise.all([pub1.executeBatch(15), pub2.executeBatch(15)]);
      await Promise.all([pub1.executeBatch(50), pub2.executeBatch(50)]);

      const overlap = claimedByPub1.filter((id) => claimedByPub2.includes(id));
      expect(overlap.length).toBe(0);
      expect(claimedByPub1.length + claimedByPub2.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "6. Out-of-order REFUND and ROLLBACK delivered before referenced BET (PENDING_REFERENCE -> PROCESSED, plus orphan -> REJECTED)",
    async () => {
      const wallet = await createWalletOnInstance(0, "100.00");
      const lateBetExtId = `late-bet-${randomUUID()}`;
      const earlyRefundExtId = `early-refund-${randomUUID()}`;

      const refundRes = await fetch(
        `${instances[0]!.url}/wagering/transactions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `prov-ooo:${earlyRefundExtId}`,
          },
          body: JSON.stringify({
            providerId: "prov-ooo",
            externalTransactionId: earlyRefundExtId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-ooo",
            gameId: "fortune-chimp",
            kind: "REFUND",
            money: { amount: "40.00", currency: "BRL" },
            referenceExternalTransactionId: lateBetExtId,
          }),
        },
      );
      expect(refundRes.status).toBe(202);
      const refundBody = (await refundRes.json()) as {
        transactionId: string;
        status: string;
      };
      expect(refundBody.status).toBe("PENDING_REFERENCE");

      const betRes = await fetch(`${instances[1]!.url}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-ooo:${lateBetExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-ooo",
          externalTransactionId: lateBetExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "round-ooo",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "40.00", currency: "BRL" },
        }),
      });
      expect(betRes.status).toBe(200);
      const betBody = (await betRes.json()) as { balance: { amount: string } };
      expect(betBody.balance.amount).toBe("60.00");

      const pendingRefWorker = instances[2]!.app.get(
        ProcessPendingReferencesUseCase,
      );
      const workerStats = await pendingRefWorker.executeBatch({
        forceDue: true,
      });
      expect(workerStats.processed).toBeGreaterThanOrEqual(1);

      const getRefundRes = await fetch(
        `${instances[0]!.url}/wagering/transactions/${refundBody.transactionId}`,
      );
      const getRefundBody = (await getRefundRes.json()) as { status: string };
      expect(getRefundBody.status).toBe("PROCESSED");

      const orphanRollbackExtId = `orphan-rb-${randomUUID()}`;
      const orphanRes = await fetch(
        `${instances[0]!.url}/wagering/transactions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `prov-ooo:${orphanRollbackExtId}`,
          },
          body: JSON.stringify({
            providerId: "prov-ooo",
            externalTransactionId: orphanRollbackExtId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-ooo",
            gameId: "fortune-chimp",
            kind: "ROLLBACK",
            money: { amount: "10.00", currency: "BRL" },
            referenceExternalTransactionId: "non-existent-bet-id",
          }),
        },
      );
      expect(orphanRes.status).toBe(202);
      const orphanBody = (await orphanRes.json()) as { transactionId: string };

      await pendingRefWorker.executeBatch({ maxAttempts: 2, forceDue: true });
      await pendingRefWorker.executeBatch({ maxAttempts: 2, forceDue: true });

      const getOrphanRes = await fetch(
        `${instances[1]!.url}/wagering/transactions/${orphanBody.transactionId}`,
      );
      const getOrphanBody = (await getOrphanRes.json()) as {
        status: string;
        failureCode: string;
      };
      expect(getOrphanBody.status).toBe("REJECTED");
      expect(getOrphanBody.failureCode).toBe("REFERENCE_NOT_FOUND");

      const rec = await instances[0]!.app
        .get(ReconcileWalletUseCase)
        .execute(wallet.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("100.00");
    },
    30_000,
  );

  it(
    "7. Service restart recovery & Global Final Invariant: wallet.balance == ledger reconstructed balance for ALL wallets",
    async () => {
      await instances[2]!.app.close();
      instances[2] = await startInstance();

      const em = instances[2]!.app.get(EntityManager).fork();
      const reconcileUseCase = instances[2]!.app.get(ReconcileWalletUseCase);

      const allWallets = await em.find(WalletOrmEntity, {});
      expect(allWallets.length).toBeGreaterThanOrEqual(createdWalletIds.size);

      for (const walletOrm of allWallets) {
        const rec = await reconcileUseCase.execute(walletOrm.id);
        expect(rec.consistent).toBe(true);
        expect(rec.storedBalance).toEqual(rec.calculatedBalance);
        expect(rec.difference.amount).toBe("0.00");
      }
    },
    30_000,
  );
});
