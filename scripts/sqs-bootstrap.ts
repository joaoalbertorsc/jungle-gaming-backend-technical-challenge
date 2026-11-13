/**
 * Creates the SQS queues used by the system (idempotent): `bun run scripts/sqs-bootstrap.ts`.
 * The topology itself lives in src/infrastructure/messaging/queue-topology.ts (shared with tests).
 */
import { SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config/load-config';
import { ensureQueueTopology } from '../src/infrastructure/messaging/queue-topology';

async function run(): Promise<void> {
  const { sqs: settings } = loadConfig(process.env);
  const sqs = new SQSClient({ region: settings.region, endpoint: settings.endpoint });

  try {
    const urls = await ensureQueueTopology(sqs, settings.queues);
    for (const url of [urls.wagerTransactionsDlq, urls.wagerTransactions, urls.wageringEvents]) {
      console.log(`queue ready: ${url}`);
    }
  } finally {
    sqs.destroy();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
