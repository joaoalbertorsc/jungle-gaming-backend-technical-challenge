import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SubmitWagerTransactionCommand } from '../../../src/modules/wagering/application/submit-wager-transaction';
import { assertLedgerMatchesBalance, count, FailAt, httpContext } from '../../support/application';
import {
  CONSUMER_NAME,
  createTestConsumer,
  peek,
  sendMessage,
  type TestConsumer,
  wagerMessage,
} from '../../support/consumer';
import { createIsolatedQueues, type IsolatedQueues, testSqsClient } from '../../support/queues';
import { TestDatabase } from '../../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** §10 SQS processing against real PostgreSQL and the SQS emulator. */
describe('WagerTransactionConsumer', () => {
  let db: TestDatabase;
  let queues: IsolatedQueues;
  let sqs: SQSClient;
  let subject: TestConsumer;

  beforeAll(async () => {
    db = await TestDatabase.create();
    // Short visibility and a low receive limit keep retry and dead-letter scenarios fast.
    queues = await createIsolatedQueues({ visibilityTimeoutSeconds: 1, maxReceiveCount: 3 });
    sqs = testSqsClient();
    subject = await createTestConsumer(db, queues);
  });

  afterAll(async () => {
    await subject.close();
    sqs.destroy();
    await queues.destroy();
    await db.drop();
  });

  async function openWallet(balance: string) {
    return subject.app.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl(balance),
      context: httpContext,
    });
  }

  async function transactionsFor(externalTransactionId: unknown) {
    return count(db.app, 'wager_transactions', {
      external_transaction_id: String(externalTransactionId),
    });
  }

  /** Polls until a poll receives nothing, or the attempts run out. */
  async function drain(consumer = subject, attempts = 6): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if ((await consumer.consumer.pollOnce()) === 0) return;
    }
  }

  it('processes a message through the same use case as HTTP, records the inbox and acks', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

    await drain();

    expect(await transactionsFor(message.data.externalTransactionId)).toBe(1);
    const [inbox] = await db.app`
      SELECT processed_at IS NOT NULL AS processed FROM inbox_messages
      WHERE consumer_name = ${CONSUMER_NAME} AND message_id = ${message.messageId}`;
    expect(inbox).toEqual({ processed: true });
    expect(await peek(sqs, queues.urls.wagerTransactions)).toEqual([]);
    await assertLedgerMatchesBalance(db.app, wallet.id);

    // Same idempotency key over HTTP afterwards: a replay, not a second debit.
    const replay = await subject.app.submit.execute({
      ...(message.data as unknown as Omit<SubmitWagerTransactionCommand, 'context'>),
      context: httpContext,
    });
    expect(replay).toMatchObject({ idempotentReplay: true, balance: brl('75.00') });
  });

  it('acks a duplicate delivery of the same message without a second effect (inbox)', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    // SQS is at-least-once: the same message can arrive twice.
    await sendMessage(sqs, queues.urls.wagerTransactions, message, {
      groupId: wallet.id,
      deduplicationId: `a-${message.messageId}`,
    });
    await sendMessage(sqs, queues.urls.wagerTransactions, message, {
      groupId: wallet.id,
      deduplicationId: `b-${message.messageId}`,
    });

    await drain();

    expect(await transactionsFor(message.data.externalTransactionId)).toBe(1);
    expect(await count(db.app, 'wallet_ledger_entries', { wallet_id: wallet.id })).toBe(2);
    expect(subject.app.metrics.calls).toContain(`duplicate:${CONSUMER_NAME}`);
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('redelivers after a failure between commit and ack, and the inbox prevents a second debit', async () => {
    const crashing = await createTestConsumer(db, queues, {
      faults: new FailAt('consumer.before-ack'),
    });
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

    try {
      await crashing.consumer.pollOnce();
      expect(await transactionsFor(message.data.externalTransactionId)).toBe(1);

      await Bun.sleep(1_200); // visibility expires: the message comes back
      await drain();

      expect(await transactionsFor(message.data.externalTransactionId)).toBe(1);
      expect(await count(db.app, 'wallet_ledger_entries', { wallet_id: wallet.id })).toBe(2);
      expect(await peek(sqs, queues.urls.wagerTransactions)).toEqual([]);
      await assertLedgerMatchesBalance(db.app, wallet.id);
    } finally {
      await crashing.close();
    }
  });

  it('acks a business rejection: it is a terminal outcome, not a failure', async () => {
    const wallet = await openWallet('10.00');
    const message = wagerMessage(wallet, { money: brl('80.00') });
    await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

    await drain();

    const [row] = await db.app`
      SELECT status, failure_code FROM wager_transactions
      WHERE external_transaction_id = ${String(message.data.externalTransactionId)}`;
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await peek(sqs, queues.urls.wagerTransactions)).toEqual([]);
  });

  describe('permanent failures go straight to the DLQ', () => {
    async function deadLetterReasons(): Promise<string[]> {
      const messages = await peek(sqs, queues.urls.wagerTransactionsDlq);
      return messages.map((m) => m.MessageAttributes?.['dlq-reason']?.StringValue ?? '?');
    }

    it('a body that is not JSON', async () => {
      await sendMessage(sqs, queues.urls.wagerTransactions, '{not json', { groupId: 'malformed' });

      await drain();

      expect(await deadLetterReasons()).toContain('MALFORMED_MESSAGE');
      expect(await peek(sqs, queues.urls.wagerTransactions)).toEqual([]);
    });

    it('a message that violates the contract (OPENING kind)', async () => {
      const wallet = await openWallet('10.00');
      await sendMessage(
        sqs,
        queues.urls.wagerTransactions,
        wagerMessage(wallet, { kind: 'OPENING' }),
        { groupId: wallet.id },
      );

      await drain();

      expect(await deadLetterReasons()).toContain('INVALID_MESSAGE');
    });

    it('an idempotency key reused with another payload', async () => {
      const wallet = await openWallet('100.00');
      const first = wagerMessage(wallet);
      const conflicting = wagerMessage(wallet, {
        externalTransactionId: first.data.externalTransactionId,
        idempotencyKey: first.data.idempotencyKey,
        money: brl('99.00'),
      });
      await sendMessage(sqs, queues.urls.wagerTransactions, first, { groupId: wallet.id });
      await sendMessage(sqs, queues.urls.wagerTransactions, conflicting, { groupId: wallet.id });

      await drain();

      expect(await deadLetterReasons()).toContain('IDEMPOTENCY_CONFLICT');
      expect(await transactionsFor(first.data.externalTransactionId)).toBe(1);
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });
  });

  describe('transient failures are retried with backoff', () => {
    it('retries while the wallet is locked, then processes once it is free', async () => {
      const impatient = await createTestConsumer(db, queues, { lockTimeoutMs: 200 });
      const wallet = await openWallet('100.00');
      const message = wagerMessage(wallet);
      const holder = await db.app.reserve();

      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
        await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

        await impatient.consumer.pollOnce();
        expect(impatient.app.metrics.calls).toContain('retry:LOCK_TIMEOUT');
        expect(await transactionsFor(message.data.externalTransactionId)).toBe(0);

        await holder`ROLLBACK`;
        await Bun.sleep(1_200); // the retry delay set through the message visibility
        await drain(impatient);

        expect(await transactionsFor(message.data.externalTransactionId)).toBe(1);
      } finally {
        await holder.release();
        await impatient.close();
      }
    });

    it('lets the redrive policy dead-letter a message whose retries are exhausted', async () => {
      const impatient = await createTestConsumer(db, queues, { lockTimeoutMs: 200 });
      const wallet = await openWallet('100.00');
      const message = wagerMessage(wallet);
      const holder = await db.app.reserve();

      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
        await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

        for (let attempt = 0; attempt < 5; attempt++) {
          await impatient.consumer.pollOnce();
          await Bun.sleep(1_100);
        }

        const deadLettered = await peek(sqs, queues.urls.wagerTransactionsDlq);
        expect(deadLettered.some((m) => m.Body?.includes(message.messageId))).toBe(true);
        expect(await transactionsFor(message.data.externalTransactionId)).toBe(0);
      } finally {
        await holder`ROLLBACK`;
        await holder.release();
        await impatient.close();
      }
    });
  });

  it('on stop(), finishes the message in flight before resolving (graceful shutdown)', async () => {
    const draining = await createTestConsumer(db, queues);
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    const holder = await db.app.reserve();

    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });
      draining.consumer.start();
      await Bun.sleep(1_500); // received and now waiting on the wallet lock

      const stopped = draining.consumer.stop();
      await Bun.sleep(200);
      await holder`ROLLBACK`;
      await stopped;

      expect(await transactionsFor(message.data.externalTransactionId)).toBe(1);
      expect(await peek(sqs, queues.urls.wagerTransactions)).toEqual([]);
    } finally {
      await holder.release();
      await draining.close();
    }
  });
});
