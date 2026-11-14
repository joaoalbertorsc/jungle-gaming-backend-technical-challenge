import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroOrmPendingReferenceQueue } from '../../../src/infrastructure/database/mikro-orm-pending-reference-queue';
import type { SubmitWagerTransactionCommand } from '../../../src/modules/wagering/application/submit-wager-transaction';
import { ReferenceRetryPolicy } from '../../../src/modules/wagering/domain/reference-retry-policy';
import { ExponentialBackoff } from '../../../src/shared/domain/exponential-backoff';
import {
  assertLedgerMatchesBalance,
  count,
  createTestApplication,
  FailAt,
  httpContext,
  outboxEventTypes,
  type TestApplication,
} from '../../support/application';
import {
  createTestRetryWorker,
  deferAllPendingReferences,
  makeDue,
  pendingRow,
  type RetryWorkerOptions,
} from '../../support/retry-worker';
import { TestDatabase } from '../../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const nextExternalId = (prefix: string) => `${prefix}-${Bun.randomUUIDv7()}`;

/** §7 rule 8 and ADR-0012: PENDING_REFERENCE transactions retried by the worker, against PostgreSQL. */
describe('RetryPendingReferences', () => {
  let db: TestDatabase;
  let app: TestApplication;

  beforeAll(async () => {
    db = await TestDatabase.create();
    app = await createTestApplication(db);
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  // Every test sees only the transactions it parks itself.
  beforeEach(() => deferAllPendingReferences(db.app));

  const worker = (options: RetryWorkerOptions = {}) => createTestRetryWorker(app, options);

  const openWallet = (balance = '100.00') =>
    app.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl(balance),
      context: httpContext,
    });

  function submit(
    wallet: { id: string; playerId: string },
    overrides: Partial<SubmitWagerTransactionCommand> & { externalTransactionId: string },
  ) {
    return app.submit.execute({
      idempotencyKey: `provider-a:${overrides.externalTransactionId}`,
      providerId: 'provider-a',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: brl('25.00'),
      context: httpContext,
      ...overrides,
    });
  }

  /** A REFUND delivered before its BET (parked as PENDING_REFERENCE), and the BET's external id. */
  async function refundBeforeBet(wallet: { id: string; playerId: string }, amount = '25.00') {
    const betId = nextExternalId('bet');
    const refund = await submit(wallet, {
      externalTransactionId: nextExternalId('refund'),
      kind: 'REFUND',
      referenceExternalTransactionId: betId,
      money: brl(amount),
    });
    expect(refund.status).toBe('PENDING_REFERENCE');
    return { refund, betId };
  }

  const balanceOf = async (walletId: string) => (await app.getWallet.execute(walletId)).balance;

  it('processes a REFUND once its BET has arrived and restores the balance', async () => {
    const wallet = await openWallet();
    const { refund, betId } = await refundBeforeBet(wallet);
    await submit(wallet, { externalTransactionId: betId }); // debits 25 and nudges the refund

    const round = await worker().retryOnce();

    expect(round.processed).toEqual([refund.transactionId]);
    expect(await pendingRow(db.app, refund.transactionId)).toEqual({
      status: 'PROCESSED',
      failure_code: null,
      reference_attempts: 1,
      scheduled: false,
    });
    expect(await balanceOf(wallet.id)).toEqual(brl('100.00'));
    expect(await outboxEventTypes(db.app, [refund.transactionId])).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    expect(
      await count(db.app, 'wallet_ledger_entries', { transaction_id: refund.transactionId }),
    ).toBe(1);
    expect(app.metrics.calls).toContain('outcome:REFUND:PROCESSED:worker');
    expect(app.metrics.calls).toContain('reference-retry:processed');
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('applies every §7 rule to the late reference: a different amount is rejected', async () => {
    const wallet = await openWallet();
    const { refund, betId } = await refundBeforeBet(wallet, '30.00');
    await submit(wallet, { externalTransactionId: betId });

    const round = await worker().retryOnce();

    expect(round.rejected).toEqual([refund.transactionId]);
    expect(await pendingRow(db.app, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'AMOUNT_MISMATCH',
    });
    expect(await balanceOf(wallet.id)).toEqual(brl('75.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('reschedules with backoff while the reference is still missing, without new events', async () => {
    const wallet = await openWallet();
    const { refund } = await refundBeforeBet(wallet);
    await makeDue(db.app, refund.transactionId);

    const round = await worker().retryOnce();

    expect(round.rescheduled).toEqual([refund.transactionId]);
    expect(await pendingRow(db.app, refund.transactionId)).toEqual({
      status: 'PENDING_REFERENCE',
      failure_code: null,
      reference_attempts: 1,
      scheduled: true,
    });
    const [row] = await db.app`
      SELECT next_reference_attempt_at BETWEEN now() + interval '1 second' AND now() + interval '3 seconds'
               AS backing_off
      FROM wager_transactions WHERE id = ${refund.transactionId}`;
    expect(row).toEqual({ backing_off: true }); // second retry: 2 s
    expect(await outboxEventTypes(db.app, [refund.transactionId])).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect((await worker().retryOnce()).rescheduled).toEqual([]); // not due yet
  });

  it('gives up after the last attempt: REJECTED with REFERENCE_NOT_FOUND and an event', async () => {
    const wallet = await openWallet();
    const { refund } = await refundBeforeBet(wallet);
    await makeDue(db.app, refund.transactionId);
    const twoQuickAttempts = new ReferenceRetryPolicy({
      maxAttempts: 2,
      backoff: new ExponentialBackoff({ baseMs: 1, factor: 1, maxMs: 1 }),
    });

    expect((await worker({ policy: twoQuickAttempts }).retryOnce()).rescheduled).toEqual([
      refund.transactionId,
    ]);
    await Bun.sleep(20);
    const last = await worker({ policy: twoQuickAttempts }).retryOnce();

    expect(last.rejected).toEqual([refund.transactionId]);
    expect(await pendingRow(db.app, refund.transactionId)).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 2,
      scheduled: false,
    });
    expect(await outboxEventTypes(db.app, [refund.transactionId])).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(wallet.id)).toEqual(brl('100.00'));
    expect(app.metrics.calls).toContain('outcome:REFUND:REJECTED:worker');
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('two workers in parallel decide each pending transaction exactly once', async () => {
    const wallets = await Promise.all([openWallet(), openWallet(), openWallet()]);
    const refunds: string[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 2; i++) {
        const { refund, betId } = await refundBeforeBet(wallet);
        await submit(wallet, { externalTransactionId: betId });
        refunds.push(refund.transactionId);
      }
    }

    const [a, b] = await Promise.all([
      worker({ batchSize: 3 }).retryOnce(),
      worker({ batchSize: 3 }).retryOnce(),
    ]);
    const rest = await worker().retryOnce();

    const processed = [...a.processed, ...b.processed, ...rest.processed];
    expect(new Set(processed).size).toBe(processed.length);
    expect(processed.sort()).toEqual([...refunds].sort());
    for (const refundId of refunds) {
      expect(await count(db.app, 'wallet_ledger_entries', { transaction_id: refundId })).toBe(1);
    }
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toEqual(brl('100.00'));
      await assertLedgerMatchesBalance(db.app, wallet.id);
    }
  });

  it('a worker that dies before commit leaves the attempt to another worker after the lease', async () => {
    const wallet = await openWallet();
    const { refund, betId } = await refundBeforeBet(wallet);
    await submit(wallet, { externalTransactionId: betId });

    const dying = worker({ faults: new FailAt('pending-reference.before-commit'), leaseMs: 300 });
    expect((await dying.retryOnce()).failed).toEqual([refund.transactionId]);
    expect(await pendingRow(db.app, refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });
    expect(await balanceOf(wallet.id)).toEqual(brl('75.00'));

    const survivor = worker();
    expect((await survivor.retryOnce()).processed).toEqual([]); // still leased
    await Bun.sleep(350);
    expect((await survivor.retryOnce()).processed).toEqual([refund.transactionId]);
    expect(await balanceOf(wallet.id)).toEqual(brl('100.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('skips a stale claim whose attempt another worker already made', async () => {
    const wallet = await openWallet();
    const { refund } = await refundBeforeBet(wallet);
    await makeDue(db.app, refund.transactionId);

    // A slow worker claims with a lease that expires before it gets to work...
    const queue = new MikroOrmPendingReferenceQueue(app.orm);
    const stale = (await queue.claimDue(new Date(), 10, 1)).filter(
      (claim) => claim.transactionId === refund.transactionId,
    );
    expect(stale).toEqual([
      { transactionId: refund.transactionId, walletId: wallet.id, attempts: 0 },
    ]);
    await Bun.sleep(20);
    // ...meanwhile another worker claims the same row and makes attempt 1.
    expect((await worker().retryOnce()).rescheduled).toEqual([refund.transactionId]);

    const slow = worker({ queue: { claimDue: () => Promise.resolve(stale) } });
    const round = await slow.retryOnce();

    expect(round.skipped).toEqual([refund.transactionId]);
    expect(await pendingRow(db.app, refund.transactionId)).toMatchObject({ reference_attempts: 1 });
  });

  it('runs as a loop and stops cleanly', async () => {
    const wallet = await openWallet();
    const { refund, betId } = await refundBeforeBet(wallet);
    const looping = worker();
    looping.start();

    try {
      await submit(wallet, { externalTransactionId: betId });
      for (let attempt = 0; attempt < 40; attempt++) {
        if ((await pendingRow(db.app, refund.transactionId))?.status === 'PROCESSED') break;
        await Bun.sleep(50);
      }
    } finally {
      await looping.stop();
    }

    expect(await pendingRow(db.app, refund.transactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await balanceOf(wallet.id)).toEqual(brl('100.00'));
  });
});
