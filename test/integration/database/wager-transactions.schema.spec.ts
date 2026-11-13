import { afterAll, beforeAll, describe, it } from 'bun:test';
import {
  expectViolation,
  insert,
  newId,
  openWallet,
  type Row,
  transactionRow,
} from '../../support/sql-fixtures';
import { TestDatabase } from '../../support/test-database';

/** §5.9 / ADR-0006 / ADR-0008: transaction invariants enforced by PostgreSQL. */
describe('schema: wager_transactions', () => {
  let db: TestDatabase;
  let wallet: Row;

  beforeAll(async () => {
    db = await TestDatabase.create();
    wallet = await openWallet(db.app, '0.00');
  });

  afterAll(async () => {
    await db.drop();
  });

  const tx = (overrides: Row = {}) => transactionRow(wallet, overrides);
  const insertTx = (row: Row) => insert(db.app, 'wager_transactions', row);
  /** Undecided rows need no resolved reference or completion time, so each test breaks one rule only. */
  const undecided = { status: 'PENDING', completed_at: null };

  describe('idempotency', () => {
    it('rejects a second transaction with the same idempotency key', async () => {
      const first = tx({ kind: 'LOSS' });
      await insertTx(first);

      await expectViolation(
        () => insertTx(tx({ kind: 'LOSS', idempotency_key: first.idempotency_key ?? null })),
        {
          sqlState: '23505',
          constraint: 'wager_transactions_idempotency_key_key',
        },
      );
    });

    it('rejects a second transaction with the same provider and external id', async () => {
      const first = tx({ kind: 'LOSS' });
      await insertTx(first);

      await expectViolation(
        () =>
          insertTx(
            tx({ kind: 'LOSS', external_transaction_id: first.external_transaction_id ?? null }),
          ),
        { sqlState: '23505', constraint: 'wager_transactions_provider_external_key' },
      );
    });

    it('accepts the same external id from another provider', async () => {
      const first = tx({ kind: 'LOSS' });
      await insertTx(first);

      await insertTx(
        tx({
          kind: 'LOSS',
          provider_id: 'provider-b',
          external_transaction_id: first.external_transaction_id ?? null,
        }),
      );
    });
  });

  describe('per-kind rules', () => {
    it.each(['REFUND', 'ROLLBACK'])('%s requires a reference', async (kind) => {
      await expectViolation(() => insertTx(tx({ kind, status: 'PENDING', completed_at: null })), {
        sqlState: '23514',
        constraint: 'wager_transactions_reversal_requires_reference',
      });
    });

    it('a BET cannot carry a reference', async () => {
      await expectViolation(
        () => insertTx(tx({ ...undecided, reference_external_transaction_id: 'ext-x' })),
        { sqlState: '23514', constraint: 'wager_transactions_reference_not_allowed' },
      );
    });

    it('a transaction cannot reference itself', async () => {
      await expectViolation(
        () =>
          insertTx(
            tx({
              ...undecided,
              kind: 'REFUND',
              external_transaction_id: 'ext-self',
              reference_external_transaction_id: 'ext-self',
            }),
          ),
        { sqlState: '23514', constraint: 'wager_transactions_no_self_reference' },
      );
    });

    it('the internal provider is reserved for OPENING', async () => {
      await expectViolation(() => insertTx(tx({ provider_id: 'internal' })), {
        sqlState: '23514',
        constraint: 'wager_transactions_internal_provider',
      });
      await expectViolation(() => insertTx(tx({ kind: 'OPENING' })), {
        sqlState: '23514',
        constraint: 'wager_transactions_internal_provider',
      });
    });

    it('balance-moving kinds need a positive amount; LOSS may be zero', async () => {
      await insertTx(tx({ kind: 'LOSS', amount: '0.00' }));

      await expectViolation(() => insertTx(tx({ kind: 'BET', amount: '0.00' })), {
        sqlState: '23514',
        constraint: 'wager_transactions_positive_amount',
      });
    });

    it.each([
      ['kind', { kind: 'JACKPOT' }, 'wager_transactions_kind_valid'],
      ['status', { status: 'DONE', completed_at: null }, 'wager_transactions_status_valid'],
      [
        'failure_code',
        { status: 'REJECTED', failure_code: 'BAD_LUCK' },
        'wager_transactions_failure_code_valid',
      ],
      ['payload_hash', { payload_hash: 'Z'.repeat(64) }, 'wager_transactions_payload_hash_format'],
    ])('rejects an unknown %s', async (_column, overrides, constraint) => {
      await expectViolation(() => insertTx(tx(overrides)), { sqlState: '23514', constraint });
    });
  });

  describe('outcome consistency', () => {
    it('REJECTED and FAILED carry a failure code; other statuses do not', async () => {
      await expectViolation(() => insertTx(tx({ status: 'REJECTED' })), {
        sqlState: '23514',
        constraint: 'wager_transactions_failure_code_matches_status',
      });
      await expectViolation(() => insertTx(tx({ failure_code: 'INSUFFICIENT_FUNDS' })), {
        sqlState: '23514',
        constraint: 'wager_transactions_failure_code_matches_status',
      });
    });

    it('terminal statuses carry completed_at; undecided ones do not', async () => {
      await expectViolation(() => insertTx(tx({ completed_at: null })), {
        sqlState: '23514',
        constraint: 'wager_transactions_completed_at_matches_status',
      });
      await expectViolation(() => insertTx(tx({ status: 'PENDING' })), {
        sqlState: '23514',
        constraint: 'wager_transactions_completed_at_matches_status',
      });
    });

    it('a decided outcome stores the balance observed at that moment', async () => {
      await expectViolation(
        () => insertTx(tx({ resulting_balance: null, resulting_balance_currency: null })),
        { sqlState: '23514', constraint: 'wager_transactions_outcome_has_balance' },
      );
    });

    it('rejects a transaction for an unknown wallet', async () => {
      await expectViolation(() => insertTx(tx({ wallet_id: newId() })), {
        sqlState: '23503',
        constraint: 'wager_transactions_wallet_id_fkey',
      });
    });
  });

  describe('single reversal (stricter than §7 rule 4, ADR-0006)', () => {
    async function processedBet(): Promise<Row> {
      const bet = tx({ kind: 'LOSS' });
      await insertTx(bet);
      return bet;
    }

    function reversal(kind: string, reference: Row, overrides: Row = {}): Row {
      return tx({
        kind,
        reference_external_transaction_id: reference.external_transaction_id ?? null,
        reference_transaction_id: reference.id ?? null,
        ...overrides,
      });
    }

    it('rejects a second processed reversal of the same reference, whatever its kind', async () => {
      const bet = await processedBet();
      await insertTx(reversal('REFUND', bet));

      await expectViolation(() => insertTx(reversal('ROLLBACK', bet)), {
        sqlState: '23505',
        constraint: 'wager_transactions_single_reversal_idx',
      });
    });

    it('still records a rejected second reversal for audit', async () => {
      const bet = await processedBet();
      await insertTx(reversal('REFUND', bet));

      await insertTx(
        reversal('REFUND', bet, {
          status: 'REJECTED',
          failure_code: 'ALREADY_REVERSED',
          reference_transaction_id: null,
        }),
      );
    });
  });

  describe('state machine (§6.3)', () => {
    async function pendingReference(): Promise<Row> {
      const refund = tx({
        kind: 'REFUND',
        reference_external_transaction_id: 'ext-not-yet',
        status: 'PENDING_REFERENCE',
        completed_at: null,
      });
      await insertTx(refund);
      return refund;
    }

    it('allows PENDING_REFERENCE → REJECTED', async () => {
      const refund = await pendingReference();

      await db.app`UPDATE wager_transactions
        SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', completed_at = now()
        WHERE id = ${refund.id}`;
    });

    it('allows retry bookkeeping while PENDING_REFERENCE', async () => {
      const refund = await pendingReference();

      await db.app`UPDATE wager_transactions
        SET reference_attempts = 1, next_reference_attempt_at = now() WHERE id = ${refund.id}`;
    });

    it('rejects going back from PENDING_REFERENCE to PENDING', async () => {
      const refund = await pendingReference();

      await expectViolation(
        () => db.app`UPDATE wager_transactions SET status = 'PENDING' WHERE id = ${refund.id}`,
        { sqlState: '23514', constraint: 'wager_transactions_transition' },
      );
    });

    it('freezes terminal rows completely', async () => {
      const bet = tx({ kind: 'LOSS' });
      await insertTx(bet);

      await expectViolation(
        () =>
          db.app`UPDATE wager_transactions
            SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' WHERE id = ${bet.id}`,
        { sqlState: '23514', constraint: 'wager_transactions_terminal_immutable' },
      );
      await expectViolation(
        () => db.app`UPDATE wager_transactions SET updated_at = now() WHERE id = ${bet.id}`,
        { sqlState: '23514', constraint: 'wager_transactions_terminal_immutable' },
      );
    });

    it.each([
      ['amount', '99.00'],
      ['kind', 'ROLLBACK'],
      ['payload_hash', 'b'.repeat(64)],
      ['idempotency_key', 'other-key'],
    ])('rejects changing the business column %s', async (column, value) => {
      const refund = await pendingReference();

      await expectViolation(
        () =>
          db.app`UPDATE wager_transactions SET ${db.app(column)} = ${value} WHERE id = ${refund.id}`,
        { sqlState: '23514', constraint: 'wager_transactions_immutable_columns' },
      );
    });

    it('rejects deleting a transaction, even for the schema owner', async () => {
      const bet = tx({ kind: 'LOSS' });
      await insertTx(bet);

      await expectViolation(() => db.owner`DELETE FROM wager_transactions WHERE id = ${bet.id}`, {
        sqlState: '23514',
        constraint: 'wager_transactions_no_delete',
      });
    });
  });
});
