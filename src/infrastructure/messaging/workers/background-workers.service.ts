import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ProcessPendingReferencesUseCase } from "../../../application/use-cases/process-pending-references.use-case";
import { PublishOutboxUseCase } from "../../../application/use-cases/publish-outbox.use-case";
import { StructuredLoggerService } from "../../observability/logger.service";

@Injectable()
export class BackgroundWorkersService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRefTimer: ReturnType<typeof setInterval> | null = null;
  private outboxRunning = false;
  private pendingRefRunning = false;

  constructor(
    private readonly publishOutboxUseCase: PublishOutboxUseCase,
    private readonly processPendingRefsUseCase: ProcessPendingReferencesUseCase,
    private readonly logger: StructuredLoggerService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WORKER_ENABLED === "false") {
      return;
    }

    const outboxIntervalMs = Number(
      process.env.OUTBOX_POLL_INTERVAL_MS ?? 200,
    );
    const pendingRefIntervalMs = Number(
      process.env.PENDING_REF_POLL_INTERVAL_MS ?? 250,
    );

    this.outboxTimer = setInterval(() => {
      if (this.outboxRunning) return;
      this.outboxRunning = true;
      this.publishOutboxUseCase
        .executeBatch(Number(process.env.OUTBOX_BATCH_SIZE ?? 50))
        .catch((err) => {
          this.logger.warn("Outbox worker tick error", {
            event: "outbox_worker_error",
            error: (err as Error)?.message,
          });
        })
        .finally(() => {
          this.outboxRunning = false;
        });
    }, outboxIntervalMs);

    this.pendingRefTimer = setInterval(() => {
      if (this.pendingRefRunning) return;
      this.pendingRefRunning = true;
      this.processPendingRefsUseCase
        .executeBatch()
        .catch((err) => {
          this.logger.warn("PendingReference worker tick error", {
            event: "pending_ref_worker_error",
            error: (err as Error)?.message,
          });
        })
        .finally(() => {
          this.pendingRefRunning = false;
        });
    }, pendingRefIntervalMs);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.pendingRefTimer) {
      clearInterval(this.pendingRefTimer);
      this.pendingRefTimer = null;
    }

    while (this.outboxRunning || this.pendingRefRunning) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

