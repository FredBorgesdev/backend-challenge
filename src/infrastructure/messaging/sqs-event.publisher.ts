import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import {
  EventPublisherPort,
  PublishableOutboxEvent,
} from "../../application/ports/event-publisher.port";
import { SqsClientService } from "./sqs-client.service";

@Injectable()
export class SqsEventPublisher implements EventPublisherPort {
  constructor(private readonly sqsService: SqsClientService) {}

  async publish(event: PublishableOutboxEvent): Promise<void> {
    const queueUrl = await this.sqsService.getQueueUrl(
      this.sqsService.integrationEventsQueueName,
    );

    await this.sqsService.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregateId || "default-group",
        MessageDeduplicationId: event.id,
      }),
    );
  }
}

