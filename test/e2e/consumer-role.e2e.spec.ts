import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createWorkerApplication } from '../../src/bootstrap/create-worker-application';
import { loadConfig } from '../../src/config/load-config';
import { count, createTestApplication, httpContext } from '../support/application';
import { sendMessage, wagerMessage } from '../support/consumer';
import { createIsolatedQueues, type IsolatedQueues, testSqsClient } from '../support/queues';
import { TestDatabase } from '../support/test-database';

/**
 * The `consumer` role wired by Nest exactly as in production (APP_ROLES=consumer): it starts
 * polling on bootstrap and drains on shutdown, before the database pool closes.
 */
describe('worker process: consumer role', () => {
  let db: TestDatabase;
  let queues: IsolatedQueues;
  let sqs: SQSClient;

  beforeAll(async () => {
    db = await TestDatabase.create();
    queues = await createIsolatedQueues();
    sqs = testSqsClient();
  });

  afterAll(async () => {
    sqs.destroy();
    await queues.destroy();
    await db.drop();
  });

  it('consumes queued wagers and shuts down cleanly', async () => {
    const seeding = await createTestApplication(db);
    const wallet = await seeding.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      context: httpContext,
    });
    await seeding.close();

    const worker = await createWorkerApplication(
      loadConfig({
        ...process.env,
        ...queues.env,
        APP_ROLES: 'consumer',
        DATABASE_URL: db.appUrl,
        SQS_WAIT_TIME_SECONDS: '1',
      }),
      { logger: false },
    );

    try {
      const message = wagerMessage(wallet);
      await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

      let processed = 0;
      for (let attempt = 0; attempt < 20 && processed === 0; attempt++) {
        await Bun.sleep(250);
        processed = await count(db.app, 'wager_transactions', {
          external_transaction_id: String(message.data.externalTransactionId),
        });
      }
      expect(processed).toBe(1);
    } finally {
      await worker.close();
    }
  });
});
