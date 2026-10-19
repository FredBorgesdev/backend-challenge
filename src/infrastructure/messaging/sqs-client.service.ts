import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { StructuredLoggerService } from "../observability/logger.service";

@Injectable()
export class SqsClientService implements OnModuleDestroy {
  public readonly client: SQSClient;
  private readonly queueUrlCache = new Map<string, string>();

  public readonly wagerQueueName: string;
  public readonly wagerDlqName: string;
  public readonly integrationEventsQueueName: string;
  public readonly maxReceiveCount: number;

  constructor(private readonly logger: StructuredLoggerService) {
    const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
    const region = process.env.AWS_REGION ?? "us-east-1";

    this.wagerQueueName =
      process.env.SQS_WAGER_QUEUE_NAME ?? "wager-transactions.fifo";
    this.wagerDlqName =
      process.env.SQS_WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo";
    this.integrationEventsQueueName =
      process.env.SQS_INTEGRATION_EVENTS_QUEUE_NAME ??
      "integration-events.fifo";
    this.maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 3);

    this.client = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  async ensureQueuesTopology(): Promise<void> {
    const dlqUrl = await this.getOrCreateFifoQueue(this.wagerDlqName);
    const dlqAttrs = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const dlqArn =
      dlqAttrs.Attributes?.QueueArn ??
      `arn:aws:sqs:us-east-1:000000000000:${this.wagerDlqName}`;

    await this.getOrCreateFifoQueue(this.wagerQueueName, {
      VisibilityTimeout: "15",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(this.maxReceiveCount),
      }),
    });

    await this.getOrCreateFifoQueue(this.integrationEventsQueueName);
  }

  async getQueueUrl(queueName: string): Promise<string> {
    const cached = this.queueUrlCache.get(queueName);
    if (cached) {
      return cached;
    }

    try {
      const res = await this.client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      if (res.QueueUrl) {
        this.queueUrlCache.set(queueName, res.QueueUrl);
        return res.QueueUrl;
      }
    } catch {
      // If queue doesn't exist yet, create it
    }

    return this.getOrCreateFifoQueue(queueName);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.getQueueUrl(this.wagerQueueName);
      return true;
    } catch (err) {
      this.logger.error("SQS readiness check failed", {
        event: "sqs_health_error",
        error: (err as Error)?.message,
      });
      return false;
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private async getOrCreateFifoQueue(
    queueName: string,
    extraAttributes: Record<string, string> = {},
  ): Promise<string> {
    const isFifo = queueName.endsWith(".fifo");
    const res = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: isFifo
          ? {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
              ...extraAttributes,
            }
          : extraAttributes,
      }),
    );
    const url = res.QueueUrl!;
    this.queueUrlCache.set(queueName, url);
    return url;
  }
}

