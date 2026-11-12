/**
 * Creates the SQS queues used by the system (idempotent): `bun run scripts/sqs-bootstrap.ts`.
 *
 *   wager-transactions.fifo      inbound wager requests, redrives to the DLQ after N receives
 *   wager-transactions-dlq.fifo  permanent failures and exhausted retries
 *   wagering-events.fifo         integration events published by the outbox relay
 */
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config/load-config';

const MAX_RECEIVE_COUNT = 5;
const VISIBILITY_TIMEOUT_SECONDS = 30;

async function createFifoQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string> = {},
): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
        ...attributes,
      },
    }),
  );
  if (QueueUrl === undefined) throw new Error(`CreateQueue returned no URL for ${name}`);
  console.log(`queue ready: ${name}`);
  return QueueUrl;
}

async function run(): Promise<void> {
  const { sqs: settings } = loadConfig(process.env);
  const sqs = new SQSClient({ region: settings.region, endpoint: settings.endpoint });

  try {
    const dlqUrl = await createFifoQueue(sqs, settings.queues.wagerTransactionsDlq);
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );
    if (Attributes?.QueueArn === undefined) throw new Error('DLQ has no ARN');

    await createFifoQueue(sqs, settings.queues.wagerTransactions, {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes.QueueArn,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      }),
    });
    await createFifoQueue(sqs, settings.queues.wageringEvents);
  } finally {
    sqs.destroy();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
