import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createWorkerApplication } from '../../src/bootstrap/create-worker-application';
import { loadConfig } from '../../src/config/load-config';
import { createTestApplication, httpContext } from '../support/application';
import { pendingRow } from '../support/retry-worker';
import { TestDatabase } from '../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** The `retry-worker` role wired by Nest exactly as in production (APP_ROLES=retry-worker). */
describe('worker process: retry-worker role', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await TestDatabase.create();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('settles a REFUND delivered before its BET and shuts down cleanly', async () => {
    const seeding = await createTestApplication(db);
    const wallet = await seeding.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl('100.00'),
      context: httpContext,
    });
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const submit = (externalTransactionId: string, kind: string, reference?: string) =>
      seeding.submit.execute({
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind,
        money: brl('25.00'),
        referenceExternalTransactionId: reference,
        context: httpContext,
      });
    const refund = await submit(`refund-${Bun.randomUUIDv7()}`, 'REFUND', betId);
    await submit(betId, 'BET');

    const worker = await createWorkerApplication(
      loadConfig({
        ...process.env,
        APP_ROLES: 'retry-worker',
        DATABASE_URL: db.appUrl,
        REFERENCE_RETRY_POLL_INTERVAL_MS: '50',
      }),
      { logger: false },
    );

    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        if ((await pendingRow(db.app, refund.transactionId))?.status === 'PROCESSED') break;
        await Bun.sleep(50);
      }
      expect(await pendingRow(db.app, refund.transactionId)).toMatchObject({
        status: 'PROCESSED',
      });
      expect((await seeding.getWallet.execute(wallet.id)).balance).toEqual(brl('100.00'));
    } finally {
      await worker.close();
      await seeding.close();
    }
  });
});
