import {
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { WagerTransactionConsumer } from '../../src/modules/wagering/interface/sqs/wager-transaction-consumer';
import { ExponentialBackoff } from '../../src/shared/domain/exponential-backoff';
import type { FaultInjector } from '../../src/shared/application/ports';
import { createTestApplication, type TestApplication } from './application';
import { type IsolatedQueues, testSqsClient } from './queues';
import type { TestDatabase } from './test-database';

export const CONSUMER_NAME = 'wager-transactions';

export interface TestConsumer {
  readonly app: TestApplication;
  readonly consumer: WagerTransactionConsumer;
  close(): Promise<void>;
}

/** The real consumer and use case on isolated queues, tuned for fast tests (1 s long poll). */
export async function createTestConsumer(
  db: TestDatabase,
  queues: IsolatedQueues,
  options: { faults?: FaultInjector; lockTimeoutMs?: number; drainTimeoutMs?: number } = {},
): Promise<TestConsumer> {
  const app = await createTestApplication(db, options);
  const sqs = testSqsClient();
  const consumer = new WagerTransactionConsumer({
    sqs,
    queueUrl: queues.urls.wagerTransactions,
    deadLetterQueueUrl: queues.urls.wagerTransactionsDlq,
    consumerName: CONSUMER_NAME,
    submit: app.submit,
    unitOfWork: app.unitOfWork,
    clock: app.clock,
    metrics: app.metrics,
    logger: app.logger,
    faults: options.faults,
    waitTimeSeconds: 1,
    maxMessages: 10,
    drainTimeoutMs: options.drainTimeoutMs ?? 10_000,
    retryBackoff: new ExponentialBackoff({ baseMs: 1_000, factor: 2, maxMs: 2_000 }),
  });
  return {
    app,
    consumer,
    async close() {
      await consumer.stop();
      sqs.destroy();
      await app.close();
    },
  };
}

export interface WagerMessageBody {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function wagerMessage(
  wallet: { id: string; playerId: string },
  data: Record<string, unknown> = {},
): WagerMessageBody {
  const externalTransactionId = `sqs-${Bun.randomUUIDv7()}`;
  return {
    messageId: `msg-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
  };
}

export async function sendMessage(
  sqs: SQSClient,
  queueUrl: string,
  body: WagerMessageBody | string,
  options: { groupId?: string; deduplicationId?: string } = {},
): Promise<void> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const fallbackId = typeof body === 'string' ? Bun.randomUUIDv7() : body.messageId;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: text,
      MessageGroupId: options.groupId ?? 'group-1',
      MessageDeduplicationId: options.deduplicationId ?? fallbackId,
    }),
  );
}

/** Receives (without consuming) whatever is visible right now. */
export async function peek(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
      MessageAttributeNames: ['All'],
    }),
  );
  return Messages;
}
