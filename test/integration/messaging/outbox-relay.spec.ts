import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import {
  createTestApplication,
  FailAt,
  httpContext,
  type TestApplication,
} from '../../support/application';
import { rejectionOf } from '../../support/assertions';
import { createIsolatedQueues, type IsolatedQueues, testSqsClient } from '../../support/queues';
import { applyOnce, createTestRelay, drainEvents } from '../../support/relay';
import { TestDatabase } from '../../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** §11 transactional outbox: publication after commit, concurrent relays, crash recovery, retries. */
describe('OutboxRelay', () => {
  let db: TestDatabase;
  let queues: IsolatedQueues;
  let sqs: SQSClient;
  let app: TestApplication;

  beforeAll(async () => {
    db = await TestDatabase.create();
    queues = await createIsolatedQueues();
    sqs = testSqsClient();
    app = await createTestApplication(db);
  });

  afterAll(async () => {
    await app.close();
    sqs.destroy();
    await queues.destroy();
    await db.drop();
  });

  const relay = (options: Omit<Parameters<typeof createTestRelay>[2], 'eventsQueueUrl'> = {}) =>
    createTestRelay(app, sqs, { eventsQueueUrl: queues.urls.wageringEvents, ...options });

  async function pendingIds(): Promise<string[]> {
    const rows: { id: string }[] =
      await db.app`SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at`;
    return rows.map((row) => row.id);
  }

  /** Publishes everything already pending so each test starts from an empty outbox. */
  async function flush(): Promise<void> {
    await relay().publishOnce();
    await drainEvents(sqs, queues.urls.wageringEvents);
  }

  async function betOn(wallet: { id: string; playerId: string }, amount = '10.00') {
    const externalTransactionId = `relay-${Bun.randomUUIDv7()}`;
    return app.submit.execute({
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: brl(amount),
      context: httpContext,
    });
  }

  const openWallet = (balance = '100.00') =>
    app.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl(balance),
      context: httpContext,
    });

  it('publishes committed events to the events queue and marks them published', async () => {
    await flush();
    const wallet = await openWallet();
    const bet = await betOn(wallet);

    const result = await relay().publishOnce();
    const events = await drainEvents(sqs, queues.urls.wageringEvents);

    expect(result.published).toHaveLength(3);
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(events.find((e) => e.eventType === 'WagerTransactionProcessed')?.aggregateId).toBe(
      bet.transactionId,
    );
    expect(await pendingIds()).toEqual([]);
  });

  it('never sees events of a transaction that rolled back (no publication before commit)', async () => {
    await flush();
    const failing = await createTestApplication(db, { faults: new FailAt('wager.before-commit') });
    const wallet = await openWallet();
    await flush();

    try {
      await rejectionOf(
        failing.submit.execute({
          idempotencyKey: 'provider-a:rolled-back',
          providerId: 'provider-a',
          externalTransactionId: `rolled-back-${Bun.randomUUIDv7()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: brl('10.00'),
          context: httpContext,
        }),
      );

      expect((await relay().publishOnce()).published).toEqual([]);
    } finally {
      await failing.close();
    }
  });

  it('two relays on the same outbox never claim the same event and lose none', async () => {
    await flush();
    const wallet = await openWallet('1000.00');
    for (let i = 0; i < 6; i++) await betOn(wallet);
    const pending = await pendingIds();

    const [a, b] = await Promise.all([
      relay({ batchSize: 5 }).publishOnce(),
      relay({ batchSize: 5 }).publishOnce(),
    ]);
    const rest = await relay().publishOnce();

    const claimed = [...a.published, ...b.published, ...rest.published];
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.sort()).toEqual([...pending].sort());
    expect(await pendingIds()).toEqual([]);
    await drainEvents(sqs, queues.urls.wageringEvents);
  });

  it('commit, then the process dies before publishing: another instance publishes after the lease', async () => {
    await flush();
    const wallet = await openWallet();
    const pending = await pendingIds();

    const dying = relay({ faults: new FailAt('outbox.before-publish'), leaseMs: 300 });
    await rejectionOf(dying.publishOnce());
    expect(await pendingIds()).toEqual(pending);

    const survivor = relay();
    expect((await survivor.publishOnce()).published).toEqual([]); // still leased
    await Bun.sleep(350);
    expect((await survivor.publishOnce()).published).toEqual(pending);

    const events = await drainEvents(sqs, queues.urls.wageringEvents);
    expect(events.map((e) => e.aggregateId)).toEqual([wallet.id]);
  });

  it('a duplicate publication is safe for a consumer that deduplicates by eventId', async () => {
    await flush();
    await openWallet();
    const eventId = (await pendingIds())[0]!;

    // Published, then the process dies before recording it: the next relay publishes it again.
    const dying = relay({ faults: new FailAt('outbox.after-publish'), leaseMs: 300 });
    await rejectionOf(dying.publishOnce());
    await Bun.sleep(350);
    expect((await relay().publishOnce()).published).toEqual([eventId]);

    const events = await drainEvents(sqs, queues.urls.wageringEvents);
    // Force a duplicate past SQS FIFO deduplication, as a non-FIFO transport would deliver it.
    const duplicate = events[0]!;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.urls.wageringEvents,
        MessageBody: JSON.stringify(duplicate.body),
        MessageGroupId: duplicate.aggregateId,
        MessageDeduplicationId: `dup-${duplicate.eventId}`,
      }),
    );
    const redelivered = await drainEvents(sqs, queues.urls.wageringEvents);

    expect(await applyOnce(db.app, [...events, ...redelivered])).toBe(1);
  });

  it('records a failed publication and retries it with backoff', async () => {
    await flush();
    await openWallet();
    const eventId = (await pendingIds())[0]!;
    const broken = createTestRelay(app, sqs, {
      eventsQueueUrl: `${queues.urls.wageringEvents}-missing`,
    });

    const failed = await broken.publishOnce();

    expect(failed).toEqual({ published: [], failed: [eventId] });
    const [row] = await db.app`
      SELECT attempts, last_error IS NOT NULL AS has_error, next_attempt_at > now() AS backing_off
      FROM outbox_messages WHERE id = ${eventId}`;
    expect(row).toEqual({ attempts: 1, has_error: true, backing_off: true });
    expect(app.metrics.calls).toContain('outbox-failed');

    await Bun.sleep(250);
    expect((await relay().publishOnce()).published).toEqual([eventId]);
  });

  it('runs as a loop and stops cleanly', async () => {
    await flush();
    const looping = relay();
    looping.start();
    const wallet = await openWallet();

    let events: Awaited<ReturnType<typeof drainEvents>> = [];
    for (let attempt = 0; attempt < 10 && events.length === 0; attempt++) {
      events = await drainEvents(sqs, queues.urls.wageringEvents);
    }
    await looping.stop();

    expect(events.map((e) => e.aggregateId)).toEqual([wallet.id]);
  });
});
