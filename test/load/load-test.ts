import { randomUUID } from "node:crypto";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { SqsClientService } from "../../src/infrastructure/messaging/sqs-client.service";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import { createConfiguredApp } from "../../src/main";

async function runLoadTest() {
  process.env.LOG_LEVEL = "error";
  process.env.WORKER_ENABLED = "true";
  process.env.SQS_CONSUMER_ENABLED = "false";

  const app1 = await createConfiguredApp();
  const app2 = await createConfiguredApp();
  const app3 = await createConfiguredApp();

  try {
    const orm = app1.get(MikroORM);
    await orm.getMigrator().up();
    await app1.get(SqsClientService).ensureQueuesTopology();

    await app1.listen(0, "127.0.0.1");
    await app2.listen(0, "127.0.0.1");
    await app3.listen(0, "127.0.0.1");

    const getUrl = (app: typeof app1) => {
      const addr = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 3000}`;
    };

    const urls = [getUrl(app1), getUrl(app2), getUrl(app3)];
    const metricsServices = [
      app1.get(MetricsService),
      app2.get(MetricsService),
      app3.get(MetricsService),
    ];
    for (const m of metricsServices) m.reset();

    console.log("==========================================================");
    console.log("  Distributed Wagering Processor — Load & Contention Test ");
    console.log("==========================================================");
    console.log("Instances running: 3 NestJS nodes + PostgreSQL 16 + LocalStack SQS");

    // 1. Provision 20 wallets (including 2 "hot wallets" that will receive heavy contention)
    const walletCount = 20;
    const wallets: Array<{ id: string; playerId: string }> = [];

    for (let i = 0; i < walletCount; i++) {
      const playerId = `load-player-${i}-${randomUUID()}`;
      const res = await fetch(`${urls[i % 3]}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: "5000.00", currency: "BRL" },
        }),
      });
      const body = (await res.json()) as { id: string; playerId: string };
      wallets.push(body);
    }

    // 2. Generate 600 operations with concurrency waves of 40 simultaneous requests
    // Mix of normal bets, wins, hot-wallet contention, and 10% idempotent replays
    const totalRequests = 600;
    const concurrency = 40;
    const latenciesMs: number[] = [];
    const statusCounts: Record<number, number> = {};

    const tasks: Array<() => Promise<void>> = [];
    const replayPayloads: Array<{
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < totalRequests; i++) {
      tasks.push(async () => {
        const targetUrl = urls[i % 3]!;
        const isHotWallet = i % 3 === 0;
        const wallet = isHotWallet
          ? wallets[i % 2]!
          : wallets[i % wallets.length]!;

        let idempotencyKey: string;
        let payload: Record<string, unknown>;

        if (i % 10 === 9 && replayPayloads.length > 0) {
          // 10% idempotent duplicate replay
          const sample =
            replayPayloads[i % replayPayloads.length]!;
          idempotencyKey = sample.idempotencyKey;
          payload = sample.payload;
        } else {
          const extId = `load-tx-${i}-${randomUUID()}`;
          idempotencyKey = `load-prov:${extId}`;
          const kind = i % 4 === 0 ? "WIN" : "BET";
          payload = {
            providerId: "load-prov",
            externalTransactionId: extId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `round-${i}`,
            gameId: "fortune-chimp",
            kind,
            money: { amount: "25.00", currency: "BRL" },
          };
          if (replayPayloads.length < 50) {
            replayPayloads.push({ idempotencyKey, payload });
          }
        }

        const t0 = performance.now();
        const res = await fetch(`${targetUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });
        await res.json();
        const dt = performance.now() - t0;

        latenciesMs.push(dt);
        statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
      });
    }

    const benchmarkStart = performance.now();
    for (let offset = 0; offset < tasks.length; offset += concurrency) {
      const wave = tasks.slice(offset, offset + concurrency);
      await Promise.all(wave.map((fn) => fn()));
    }
    const totalDurationSec = (performance.now() - benchmarkStart) / 1000;

    // Drain any remaining outbox messages across the 3 instances
    await Promise.all([
      app1.get(PublishOutboxUseCase).executeBatch(500),
      app2.get(PublishOutboxUseCase).executeBatch(500),
      app3.get(PublishOutboxUseCase).executeBatch(500),
    ]);

    // Verify reconciliation on all 20 wallets
    const reconcileUseCase = app1.get(ReconcileWalletUseCase);
    let allConsistent = true;
    for (const w of wallets) {
      const rec = await reconcileUseCase.execute(w.id);
      if (!rec.consistent) {
        allConsistent = false;
      }
    }

    latenciesMs.sort((a, b) => a - b);
    const pct = (p: number) =>
      Number(
        (
          latenciesMs[
            Math.min(
              latenciesMs.length - 1,
              Math.floor((p / 100) * latenciesMs.length),
            )
          ] ?? 0
        ).toFixed(2),
      );

    const snaps = metricsServices.map((m) => m.getSnapshot());
    const totalDuplicates = snaps.reduce(
      (acc, s) => acc + s.duplicatesDetectedTotal,
      0,
    );
    const totalLockConflicts = snaps.reduce(
      (acc, s) => acc + s.lockConflictsTotal,
      0,
    );
    const maxOutboxLagMs = Math.max(
      ...snaps.map((s) => s.outboxLagMs.maxObservedMs),
    );
    const outboxPublishedTotal = snaps.reduce(
      (acc, s) => acc + s.outboxLagMs.publishedTotal,
      0,
    );

    const pendingOutboxCount = await app1
      .get(EntityManager)
      .fork()
      .getConnection()
      .execute<Array<{ cnt: string }>>(
        `SELECT COUNT(*)::text AS cnt FROM outbox_messages WHERE published_at IS NULL`,
      );

    const report = {
      totalRequests,
      concurrency,
      instances: 3,
      durationSeconds: Number(totalDurationSec.toFixed(2)),
      throughputRps: Number((totalRequests / totalDurationSec).toFixed(2)),
      latencyMs: {
        p50: pct(50),
        p95: pct(95),
        p99: pct(99),
        max: Number((latenciesMs[latenciesMs.length - 1] ?? 0).toFixed(2)),
      },
      httpStatusBreakdown: statusCounts,
      errorRate5xxPercent: Number(
        (((statusCounts[500] ?? 0) + (statusCounts[503] ?? 0)) /
          totalRequests) *
          100,
      ),
      idempotentReplaysDetected: totalDuplicates,
      lockConflictsDetected: totalLockConflicts,
      outbox: {
        publishedTotal: outboxPublishedTotal,
        maxObservedLagMs: maxOutboxLagMs,
        remainingUnpublished: Number(pendingOutboxCount[0]?.cnt ?? 0),
      },
      reconciliationInvariantAllWalletsConsistent: allConsistent,
    };

    console.log(JSON.stringify(report, null, 2));
    if (!allConsistent) {
      process.exit(1);
    }
  } finally {
    await app1.close().catch(() => undefined);
    await app2.close().catch(() => undefined);
    await app3.close().catch(() => undefined);
  }
}

runLoadTest().catch((err) => {
  console.error(err);
  process.exit(1);
});

