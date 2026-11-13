import { afterAll, beforeAll, describe, it } from 'bun:test';
import { AT, expectViolation, insert, newId } from '../../support/sql-fixtures';
import { TestDatabase } from '../../support/test-database';

/** ADR-0010 / ADR-0011: inbox deduplication and outbox bookkeeping, plus runtime-role limits. */
describe('schema: inbox, outbox and roles', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await TestDatabase.create();
  });

  afterAll(async () => {
    await db.drop();
  });

  const inboxRow = (overrides: Record<string, string | null> = {}) => ({
    consumer_name: 'wager-transactions',
    message_id: `msg-${newId()}`,
    payload_hash: 'c'.repeat(64),
    received_at: AT,
    processed_at: null,
    ...overrides,
  });

  const outboxRow = (overrides: Record<string, string | number | null> = {}) => ({
    id: newId(),
    aggregate_id: newId(),
    event_type: 'WalletBalanceChanged',
    payload: JSON.stringify({ eventId: 'e' }),
    occurred_at: AT,
    attempts: 0,
    next_attempt_at: AT,
    published_at: null,
    ...overrides,
  });

  describe('inbox_messages', () => {
    it('deduplicates by (consumer_name, message_id)', async () => {
      const first = inboxRow();
      await insert(db.app, 'inbox_messages', first);

      await expectViolation(
        () => insert(db.app, 'inbox_messages', inboxRow({ message_id: first.message_id })),
        { sqlState: '23505', constraint: 'inbox_messages_pkey' },
      );
    });

    it('lets another consumer record the same message id', async () => {
      const first = inboxRow();
      await insert(db.app, 'inbox_messages', first);

      await insert(
        db.app,
        'inbox_messages',
        inboxRow({ message_id: first.message_id, consumer_name: 'another-consumer' }),
      );
    });
  });

  describe('outbox_messages', () => {
    it('stores a pending event', async () => {
      await insert(db.app, 'outbox_messages', outboxRow());
    });

    it('rejects a negative attempt counter', async () => {
      await expectViolation(() => insert(db.app, 'outbox_messages', outboxRow({ attempts: -1 })), {
        sqlState: '23514',
        constraint: 'outbox_messages_attempts_non_negative',
      });
    });
  });

  describe('runtime role', () => {
    it('cannot run DDL', async () => {
      await expectViolation(() => db.app`CREATE TABLE intruder (id int)`, { sqlState: '42501' });
    });

    it('cannot drop tables', async () => {
      await expectViolation(() => db.app`DROP TABLE outbox_messages`, { sqlState: '42501' });
    });
  });
});
