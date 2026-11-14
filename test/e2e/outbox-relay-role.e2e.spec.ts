import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createWorkerApplication } from '../../src/bootstrap/create-worker-application';
import { loadConfig } from '../../src/config/load-config';
import { createTestApplication, httpContext } from '../support/application';
import { createIsolatedQueues, type IsolatedQueues, testSqsClient } from '../support/queues';
import { drainEvents } from '../support/relay';
import { TestDatabase } from '../support/test-database';

/** The `outbox-relay` role wired by Nest exactly as in production (APP_ROLES=outbox-relay). */
describe('worker process: outbox-relay role', () => {
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

  it('publishes committed events and shuts down cleanly', async () => {
    const seeding = await createTestApplication(db);
    const wallet = await seeding.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
      context: httpContext,
    });
    await seeding.close();

    const worker = await createWorkerApplication(
      loadConfig({
        ...process.env,
        ...queues.env,
        APP_ROLES: 'outbox-relay',
        DATABASE_URL: db.appUrl,
        OUTBOX_POLL_INTERVAL_MS: '50',
      }),
      { logger: false },
    );

    try {
      let events: Awaited<ReturnType<typeof drainEvents>> = [];
      for (let attempt = 0; attempt < 10 && events.length === 0; attempt++) {
        events = await drainEvents(sqs, queues.urls.wageringEvents);
      }
      expect(events.map((event) => [event.eventType, event.aggregateId])).toEqual([
        ['WalletBalanceChanged', wallet.id],
      ]);
    } finally {
      await worker.close();
    }
  });
});
