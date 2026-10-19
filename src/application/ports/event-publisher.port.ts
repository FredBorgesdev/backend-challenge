export const EVENT_PUBLISHER_PORT = Symbol("EVENT_PUBLISHER_PORT");

export interface PublishableOutboxEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface EventPublisherPort {
  publish(event: PublishableOutboxEvent): Promise<void>;
}

