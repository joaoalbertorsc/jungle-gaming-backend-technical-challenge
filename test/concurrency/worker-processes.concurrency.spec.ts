import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { FAULT_CRASH_EXIT_CODE } from '../../src/infrastructure/system/system-adapters';
import {
  assertEveryWalletConsistent,
  assertLedgerMatchesBalance,
  createTestApplication,
  httpContext,
  type TestApplication,
} from '../support/application';
import { sendMessage, type WagerMessageBody, wagerMessage } from '../support/consumer';
import { eventually, ProcessGroup } from '../support/processes';
import { createIsolatedQueues, type IsolatedQueues, testSqsClient } from '../support/queues';
import { applyOnce, drainEvents, type ReceivedEvent } from '../support/relay';
import { TestDatabase } from '../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

/**
 * §13 scenarios 4 to 8 with worker processes: SQS consumers, outbox relays and the retry worker run
 * as separate OS processes that the tests start, kill (SIGKILL) and stop (SIGTERM).
 */
describe('concurrency: worker processes, crashes and restarts', () => {
  let db: TestDatabase;
  let queues: IsolatedQueues;
  let sqs: SQSClient;
  let app: TestApplication;
  let group: ProcessGroup;

  beforeAll(async () => {
    db = await TestDatabase.create();
    // A short visibility timeout, so a message held by a dead consumer comes back quickly.
    queues = await createIsolatedQueues({ visibilityTimeoutSeconds: 2 });
    sqs = testSqsClient();
    app = await createTestApplication(db);
    group = new ProcessGroup({
      DATABASE_URL: db.appUrl,
      DB_LOCK_TIMEOUT_MS: '10000',
      OUTBOX_LEASE_MS: '500',
      REFERENCE_RETRY_LEASE_MS: '500',
      ...queues.env,
    });
  });

  afterEach(async () => {
    await group.killAll();
    await assertEveryWalletConsistent(db.app);
  });

  afterAll(async () => {
    await app.close();
    sqs.destroy();
    await queues.destroy();
    await db.drop();
  });

  const openWallet = (balance = '100.00'): Promise<WalletRef> =>
    app.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl(balance),
      context: httpContext,
    });

  const send = (
    message: WagerMessageBody,
    options: { groupId?: string; deduplicationId?: string } = {},
  ) =>
    sendMessage(sqs, queues.urls.wagerTransactions, message, {
      groupId: options.groupId ?? message.messageId,
      ...options,
    });

  const externalId = (message: WagerMessageBody) => String(message.data.externalTransactionId);

  async function statuses(messages: readonly WagerMessageBody[]): Promise<Map<string, string>> {
    const rows: { external_transaction_id: string; status: string }[] = await db.app`
      SELECT external_transaction_id, status FROM wager_transactions
      WHERE external_transaction_id IN ${db.app(messages.map(externalId))}`;
    return new Map(rows.map((row) => [row.external_transaction_id, row.status]));
  }

  async function allDecided(messages: readonly WagerMessageBody[]): Promise<boolean> {
    const found = await statuses(messages);
    return (
      found.size === messages.length &&
      [...found.values()].every((status) => status === 'PROCESSED' || status === 'REJECTED')
    );
  }

  /** Nothing left on the wager queue: neither visible nor held by a consumer. */
  async function queueDrained(): Promise<boolean> {
    const { Attributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.urls.wagerTransactions,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      Attributes.ApproximateNumberOfMessages === '0' &&
      Attributes.ApproximateNumberOfMessagesNotVisible === '0'
    );
  }

  async function ledgerEntries(walletId: string, direction: 'CREDIT' | 'DEBIT'): Promise<number> {
    const [row] = await db.app`
      SELECT count(*)::int AS n FROM wallet_ledger_entries
      WHERE wallet_id = ${walletId} AND direction = ${direction}`;
    return (row as { n: number }).n;
  }

  const balanceOf = async (walletId: string) => (await app.getWallet.execute(walletId)).balance;

  it('scenario 4: three consumer processes receive operations of one wallet; each applies once', async () => {
    const wallet = await openWallet('100.00');
    const messages = range(30).map(() => wagerMessage(wallet, { money: brl('1.00') }));
    // One group per message, so the broker hands same-wallet messages to different consumers at
    // once (ordering is an optimization, the database is the guarantee). Each is also redelivered.
    for (const message of messages) {
      await send(message);
      await send(message, { deduplicationId: `again-${message.messageId}` });
    }

    await Promise.all(range(3).map(() => group.spawn('consumer')));

    await eventually('every message decided and acked', async () => {
      return (await allDecided(messages)) && (await queueDrained());
    });
    expect(await ledgerEntries(wallet.id, 'DEBIT')).toBe(30);
    expect(await balanceOf(wallet.id)).toEqual(brl('70.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('scenario 5: a consumer killed after commit and before ack does not apply the message twice', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet, { money: brl('10.00') });
    await send(message);

    const crashing = await group.spawn('consumer', {
      env: { FAULT_CRASH_AT: 'consumer.before-ack' },
      waitUntilReady: false,
    });
    expect(await crashing.exited).toBe(FAULT_CRASH_EXIT_CODE);

    // Committed but never acked: the effect is in the database and the message is still queued.
    expect(await statuses([message])).toEqual(new Map([[externalId(message), 'PROCESSED']]));
    expect(await queueDrained()).toBe(false);

    await group.spawn('consumer');
    await eventually('the redelivered message acked', queueDrained);

    expect(await ledgerEntries(wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(wallet.id)).toEqual(brl('90.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('scenario 6: two relay processes on one outbox, after a relay died mid-publication, lose nothing', async () => {
    for (const _ of range(10)) await openWallet('10.00');

    // A relay publishes its first event and dies before recording it.
    const dying = await group.spawn('outbox-relay', {
      env: { FAULT_CRASH_AT: 'outbox.after-publish' },
      waitUntilReady: false,
    });
    expect(await dying.exited).toBe(FAULT_CRASH_EXIT_CODE);

    // Two relays share the outbox while new events keep arriving.
    await Promise.all([group.spawn('outbox-relay'), group.spawn('outbox-relay')]);
    for (const _ of range(20)) await openWallet('10.00');

    await eventually('every outbox message published', async () => {
      const [row] =
        await db.app`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
      return (row as { n: number }).n === 0;
    });
    const received: ReceivedEvent[] = [];
    for (let batch = await drainEvents(sqs, queues.urls.wageringEvents); batch.length > 0;) {
      received.push(...batch);
      batch = await drainEvents(sqs, queues.urls.wageringEvents);
    }
    const outboxIds: { id: string }[] = await db.app`SELECT id FROM outbox_messages`;

    // At least once: every event arrived; a consumer deduplicating by eventId applies each once.
    expect(new Set(received.map((event) => event.eventId))).toEqual(
      new Set(outboxIds.map((row) => row.id)),
    );
    expect(await applyOnce(db.app, received)).toBe(outboxIds.length);
  });

  it('scenario 7: a REFUND and a ROLLBACK delivered before their BETs settle through the retry worker', async () => {
    const wallet = await openWallet('100.00');
    const [refundedBet, rolledBackBet] = [`bet-${Bun.randomUUIDv7()}`, `bet-${Bun.randomUUIDv7()}`];
    const betMessage = (id: string, amount: string) =>
      wagerMessage(wallet, {
        externalTransactionId: id,
        idempotencyKey: `provider-a:${id}`,
        money: brl(amount),
      });
    const refund = wagerMessage(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: refundedBet,
      money: brl('10.00'),
    });
    const rollback = wagerMessage(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: rolledBackBet,
      money: brl('20.00'),
    });
    await Promise.all([group.spawn('consumer'), group.spawn('retry-worker')]);

    await send(refund);
    await send(rollback);
    await eventually('both reversals parked', async () => {
      const found = await statuses([refund, rollback]);
      return [...found.values()].filter((status) => status === 'PENDING_REFERENCE').length === 2;
    });
    const bets = [betMessage(refundedBet, '10.00'), betMessage(rolledBackBet, '20.00')];
    for (const bet of bets) await send(bet);

    await eventually('reversals settled', () => allDecided([refund, rollback, ...bets]));
    expect([...(await statuses([refund, rollback, ...bets])).values()]).toEqual(
      range(4).map(() => 'PROCESSED'),
    );
    expect(await ledgerEntries(wallet.id, 'DEBIT')).toBe(2);
    expect(await ledgerEntries(wallet.id, 'CREDIT')).toBe(3); // opening + two reversals
    expect(await balanceOf(wallet.id)).toEqual(brl('100.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('scenario 8: consumers killed and restarted mid-stream converge to the exact final state', async () => {
    const wallets = await Promise.all(range(5).map(() => openWallet('100.00')));
    const messages = wallets.flatMap((wallet) =>
      range(10).map(() => wagerMessage(wallet, { money: brl('2.00') })),
    );
    const [first, second] = await Promise.all([group.spawn('consumer'), group.spawn('consumer')]);
    await Promise.all(messages.map((message) => send(message)));

    await eventually('the stream under way', async () => (await statuses(messages)).size >= 10);
    await first.kill(); // crash: in-flight messages come back after the visibility timeout
    expect(await second.stop()).toBe(0); // graceful: finishes or releases its messages
    await Promise.all([group.spawn('consumer'), group.spawn('consumer')]);

    await eventually(
      'every message decided and acked after the restart',
      async () => (await allDecided(messages)) && (await queueDrained()),
      { timeoutMs: 60_000 },
    );
    for (const wallet of wallets) {
      expect(await ledgerEntries(wallet.id, 'DEBIT')).toBe(10);
      expect(await balanceOf(wallet.id)).toEqual(brl('80.00'));
      await assertLedgerMatchesBalance(db.app, wallet.id);
    }
  });
});
