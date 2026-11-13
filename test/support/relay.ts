import { ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import { MikroOrmOutboxStore } from '../../src/infrastructure/database/mikro-orm-outbox-store';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { OutboxRelay } from '../../src/modules/messaging/application/outbox-relay';
import type { FaultInjector } from '../../src/shared/application/ports';
import { ExponentialBackoff } from '../../src/shared/domain/exponential-backoff';
import type { TestApplication } from './application';

export interface RelayOptions {
  readonly eventsQueueUrl: string;
  readonly faults?: FaultInjector;
  readonly leaseMs?: number;
  readonly batchSize?: number;
}

/** A real relay (PostgreSQL store + SQS publisher) tuned for fast tests. */
export function createTestRelay(app: TestApplication, sqs: SQSClient, options: RelayOptions): OutboxRelay {
  return new OutboxRelay({
    store: new MikroOrmOutboxStore(app.orm),
    publisher: new SqsEventPublisher(sqs, options.eventsQueueUrl),
    clock: app.clock,
    metrics: app.metrics,
    logger: app.logger,
    faults: options.faults,
    batchSize: options.batchSize ?? 50,
    leaseMs: options.leaseMs ?? 30_000,
    pollIntervalMs: 50,
    retryBackoff: new ExponentialBackoff({ baseMs: 200, factor: 2, maxMs: 1_000 }),
  });
}

export interface ReceivedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly body: Record<string, unknown>;
}

/** Receives and deletes everything currently on the events queue. */
export async function drainEvents(sqs: SQSClient, queueUrl: string): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (Messages.length === 0) break;
    for (const message of Messages) {
      const body = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
      received.push({
        eventId: String(body.eventId),
        eventType: String(body.eventType),
        aggregateId: String(body.aggregateId),
        body,
      });
      const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return received;
}

/**
 * A reference downstream consumer (§11 step 5): it applies each event at most once by recording
 * the eventId in its own inbox, so a duplicate publication has no effect.
 */
export async function applyOnce(sql: SQL, events: readonly ReceivedEvent[]): Promise<number> {
  let applied = 0;
  for (const event of events) {
    const rows: unknown[] = await sql`
      INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
      VALUES ('reference-event-consumer', ${event.eventId}, ${'e'.repeat(64)}, now(), now())
      ON CONFLICT DO NOTHING RETURNING message_id`;
    applied += rows.length;
  }
  return applied;
}
