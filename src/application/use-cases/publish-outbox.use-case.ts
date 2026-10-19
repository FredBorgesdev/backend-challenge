import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { EVENT_PUBLISHER_PORT } from "../ports/event-publisher.port";
import type { EventPublisherPort } from "../ports/event-publisher.port";
import { StructuredLoggerService } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { OutboxMessageOrmEntity } from "../../infrastructure/persistence/entities/orm-entities";
import { OutboxMessageMapper } from "../../infrastructure/persistence/mappers/domain-mappers";

export interface PublishOutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

@Injectable()
export class PublishOutboxUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(EVENT_PUBLISHER_PORT)
    private readonly eventPublisher: EventPublisherPort,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Busca mensagens pendentes na outbox com `FOR UPDATE SKIP LOCKED`, garantindo que múltiplos
   * workers/instâncias publiquem simultaneamente sem colisão e sem perda de eventos.
   */
  async executeBatch(batchSize = 50): Promise<PublishOutboxBatchResult> {
    return this.em.fork().transactional(async (txEm) => {
      const rows = await txEm.getConnection().execute<
        Array<{
          id: string;
          aggregate_id: string;
          event_type: string;
          payload: Record<string, unknown> | string;
          occurred_at: Date;
          attempts: number;
          next_attempt_at: Date | null;
          published_at: Date | null;
        }>
      >(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         FROM outbox_messages
         WHERE published_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY occurred_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );

      if (rows.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      let published = 0;
      let failed = 0;

      for (const row of rows) {
        const orm = new OutboxMessageOrmEntity();
        orm.id = row.id;
        orm.aggregateId = row.aggregate_id;
        orm.eventType = row.event_type;
        orm.payload =
          typeof row.payload === "string"
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : row.payload;
        orm.occurredAt = new Date(row.occurred_at);
        orm.attempts = Number(row.attempts);
        orm.nextAttemptAt = row.next_attempt_at
          ? new Date(row.next_attempt_at)
          : null;
        orm.publishedAt = row.published_at ? new Date(row.published_at) : null;

        const outboxMsg = OutboxMessageMapper.toDomain(orm);
        const now = new Date();

        try {
          await this.eventPublisher.publish({
            id: outboxMsg.id,
            aggregateId: outboxMsg.aggregateId,
            eventType: outboxMsg.eventType,
            payload: outboxMsg.payload,
          });

          outboxMsg.markPublished(now);
          await txEm.getConnection().execute(
            `UPDATE outbox_messages
             SET published_at = ?, next_attempt_at = NULL
             WHERE id = ?`,
            [now, outboxMsg.id],
          );

          const lagMs = now.getTime() - outboxMsg.occurredAt.getTime();
          this.metrics.recordOutboxPublished(lagMs);
          published++;
        } catch (err: unknown) {
          outboxMsg.scheduleRetry(now);
          await txEm.getConnection().execute(
            `UPDATE outbox_messages
             SET attempts = ?, next_attempt_at = ?
             WHERE id = ?`,
            [outboxMsg.attempts, outboxMsg.nextAttemptAt ?? now, outboxMsg.id],
          );

          this.metrics.incrementRetry("outbox");
          this.logger.warn("Failed to publish outbox message; scheduled retry", {
            event: "outbox_publish_retry",
            outboxId: outboxMsg.id,
            eventType: outboxMsg.eventType,
            attempts: outboxMsg.attempts,
            error: (err as Error)?.message,
          });
          failed++;
        }
      }

      return { claimed: rows.length, published, failed };
    });
  }
}
