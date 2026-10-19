import { Injectable } from "@nestjs/common";

export interface MetricsSnapshot {
  transactionsByStatus: Record<string, number>;
  transactionsByKind: Record<string, number>;
  rejectionsByFailureCode: Record<string, number>;
  duplicatesDetectedTotal: number;
  idempotencyConflictsTotal: number;
  retriesTotal: {
    sqs: number;
    outbox: number;
    pendingReference: number;
    dbSerialization: number;
  };
  dlqMessagesTotal: number;
  lockConflictsTotal: number;
  reconciliationDiscrepanciesTotal: number;
  outboxLagMs: {
    lastObservedMs: number;
    maxObservedMs: number;
    publishedTotal: number;
  };
  processingLatencyMs: {
    count: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
}

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus = new Map<string, number>();
  private readonly transactionsByKind = new Map<string, number>();
  private readonly rejectionsByFailureCode = new Map<string, number>();
  private duplicatesDetectedTotal = 0;
  private idempotencyConflictsTotal = 0;
  private sqsRetriesTotal = 0;
  private outboxRetriesTotal = 0;
  private pendingReferenceRetriesTotal = 0;
  private dbSerializationRetriesTotal = 0;
  private dlqMessagesTotal = 0;
  private lockConflictsTotal = 0;
  private reconciliationDiscrepanciesTotal = 0;
  private lastOutboxLagMs = 0;
  private maxOutboxLagMs = 0;
  private outboxPublishedTotal = 0;
  private readonly latencySamplesMs: number[] = [];
  private static readonly MAX_SAMPLES = 10_000;

  recordTransactionStatus(
    status: string,
    kind?: string,
    failureCode?: string,
  ): void {
    this.transactionsByStatus.set(
      status,
      (this.transactionsByStatus.get(status) ?? 0) + 1,
    );
    if (kind) {
      this.transactionsByKind.set(
        kind,
        (this.transactionsByKind.get(kind) ?? 0) + 1,
      );
    }
    if (failureCode) {
      this.rejectionsByFailureCode.set(
        failureCode,
        (this.rejectionsByFailureCode.get(failureCode) ?? 0) + 1,
      );
    }
  }

  incrementDuplicateDetected(): void {
    this.duplicatesDetectedTotal += 1;
  }

  incrementIdempotencyConflict(): void {
    this.idempotencyConflictsTotal += 1;
  }

  incrementRetry(
    source: "sqs" | "outbox" | "pendingReference" | "dbSerialization",
  ): void {
    switch (source) {
      case "sqs":
        this.sqsRetriesTotal += 1;
        break;
      case "outbox":
        this.outboxRetriesTotal += 1;
        break;
      case "pendingReference":
        this.pendingReferenceRetriesTotal += 1;
        break;
      case "dbSerialization":
        this.dbSerializationRetriesTotal += 1;
        break;
    }
  }

  incrementDlqMessages(): void {
    this.dlqMessagesTotal += 1;
  }

  incrementLockConflict(): void {
    this.lockConflictsTotal += 1;
  }

  incrementReconciliationDiscrepancy(): void {
    this.reconciliationDiscrepanciesTotal += 1;
  }

  recordOutboxPublished(lagMs: number): void {
    const normalizedLag = Math.max(0, lagMs);
    this.lastOutboxLagMs = normalizedLag;
    if (normalizedLag > this.maxOutboxLagMs) {
      this.maxOutboxLagMs = normalizedLag;
    }
    this.outboxPublishedTotal += 1;
  }

  recordProcessingLatency(durationMs: number): void {
    if (this.latencySamplesMs.length >= MetricsService.MAX_SAMPLES) {
      this.latencySamplesMs.shift();
    }
    this.latencySamplesMs.push(Math.max(0, durationMs));
  }

  getSnapshot(): MetricsSnapshot {
    const sorted = [...this.latencySamplesMs].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);

    const percentile = (p: number): number => {
      if (count === 0) return 0;
      const idx = Math.min(count - 1, Math.floor((p / 100) * count));
      return Number((sorted[idx] ?? 0).toFixed(2));
    };

    return {
      transactionsByStatus: Object.fromEntries(this.transactionsByStatus),
      transactionsByKind: Object.fromEntries(this.transactionsByKind),
      rejectionsByFailureCode: Object.fromEntries(this.rejectionsByFailureCode),
      duplicatesDetectedTotal: this.duplicatesDetectedTotal,
      idempotencyConflictsTotal: this.idempotencyConflictsTotal,
      retriesTotal: {
        sqs: this.sqsRetriesTotal,
        outbox: this.outboxRetriesTotal,
        pendingReference: this.pendingReferenceRetriesTotal,
        dbSerialization: this.dbSerializationRetriesTotal,
      },
      dlqMessagesTotal: this.dlqMessagesTotal,
      lockConflictsTotal: this.lockConflictsTotal,
      reconciliationDiscrepanciesTotal: this.reconciliationDiscrepanciesTotal,
      outboxLagMs: {
        lastObservedMs: Number(this.lastOutboxLagMs.toFixed(2)),
        maxObservedMs: Number(this.maxOutboxLagMs.toFixed(2)),
        publishedTotal: this.outboxPublishedTotal,
      },
      processingLatencyMs: {
        count,
        avgMs: count > 0 ? Number((sum / count).toFixed(2)) : 0,
        p50Ms: percentile(50),
        p95Ms: percentile(95),
        p99Ms: percentile(99),
        maxMs: count > 0 ? Number((sorted[count - 1] ?? 0).toFixed(2)) : 0,
      },
    };
  }

  reset(): void {
    this.transactionsByStatus.clear();
    this.transactionsByKind.clear();
    this.rejectionsByFailureCode.clear();
    this.duplicatesDetectedTotal = 0;
    this.idempotencyConflictsTotal = 0;
    this.sqsRetriesTotal = 0;
    this.outboxRetriesTotal = 0;
    this.pendingReferenceRetriesTotal = 0;
    this.dbSerializationRetriesTotal = 0;
    this.dlqMessagesTotal = 0;
    this.lockConflictsTotal = 0;
    this.reconciliationDiscrepanciesTotal = 0;
    this.lastOutboxLagMs = 0;
    this.maxOutboxLagMs = 0;
    this.outboxPublishedTotal = 0;
    this.latencySamplesMs.length = 0;
  }
}

