import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../modules/messaging/application/outbox-relay';
import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';

/**
 * Publishes integration events to `wagering-events.fifo` (ADR-0011). The body is the serialized
 * envelope stored in the outbox. MessageGroupId keeps per-aggregate order; MessageDeduplicationId
 * (the eventId) lets SQS drop republished copies within its window, an optimization only:
 * consumers still deduplicate by eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
          eventId: { DataType: 'String', StringValue: message.id },
        },
      }),
    );
  }
}
