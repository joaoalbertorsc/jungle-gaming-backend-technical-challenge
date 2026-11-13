import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  applyMovement,
  expectViolation,
  insert,
  ledgerRow,
  openWallet,
  type Row,
  transactionRow,
} from '../../support/sql-fixtures';
import { TestDatabase } from '../../support/test-database';

/** §5.5 / §5.9 / ADR-0006: the ledger is append-only, balanced and chained, enforced by PostgreSQL. */
describe('schema: wallet_ledger_entries', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await TestDatabase.create();
  });

  afterAll(async () => {
    await db.drop();
  });

  /** Wallet at 100.00 / v1 plus one valid DEBIT of 10.00 (v2); returns the wallet and the entry id. */
  async function walletWithOneDebit(): Promise<{ wallet: Row; entryId: string }> {
    const wallet = await openWallet(db.app, '100.00');
    const bet = await applyMovement(db.app, wallet, {
      direction: 'DEBIT',
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '90.00',
      version: 2,
    });
    const rows: { id: string }[] =
      await db.app`SELECT id FROM wallet_ledger_entries WHERE transaction_id = ${bet.id}`;
    return { wallet, entryId: rows[0]!.id };
  }

  /** Inserts a transaction and tries to add one ledger entry for it. */
  async function addEntry(wallet: Row, overrides: Row): Promise<void> {
    const transaction = transactionRow(wallet);
    await db.app.begin(async (tx) => {
      await insert(tx, 'wager_transactions', transaction);
      await insert(tx, 'wallet_ledger_entries', ledgerRow(wallet, transaction, overrides));
    });
  }

  describe('append-only (§5.5)', () => {
    it('rejects UPDATE, even for the schema owner', async () => {
      const { entryId } = await walletWithOneDebit();

      await expectViolation(
        () => db.owner`UPDATE wallet_ledger_entries SET amount = '1.00' WHERE id = ${entryId}`,
        { sqlState: '23514', constraint: 'wallet_ledger_entries_append_only' },
      );
    });

    it('rejects DELETE, even for the schema owner', async () => {
      const { entryId } = await walletWithOneDebit();

      await expectViolation(() => db.owner`DELETE FROM wallet_ledger_entries WHERE id = ${entryId}`, {
        sqlState: '23514',
        constraint: 'wallet_ledger_entries_append_only',
      });
    });

    it('rejects TRUNCATE, even for the schema owner', async () => {
      await walletWithOneDebit();

      await expectViolation(() => db.owner`TRUNCATE wallet_ledger_entries CASCADE`, {
        sqlState: '23514',
        constraint: 'wallet_ledger_entries_append_only',
      });
    });

    it.each(['UPDATE', 'DELETE'])('does not grant %s to the runtime role', async (statement) => {
      const { entryId } = await walletWithOneDebit();
      const query =
        statement === 'UPDATE'
          ? () => db.app`UPDATE wallet_ledger_entries SET amount = '1.00' WHERE id = ${entryId}`
          : () => db.app`DELETE FROM wallet_ledger_entries WHERE id = ${entryId}`;

      await expectViolation(query, { sqlState: '42501' });
    });
  });

  describe('entry arithmetic', () => {
    it('rejects an entry whose before ± amount is not its after', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await expectViolation(() => addEntry(wallet, { balance_after: '91.00' }), {
        sqlState: '23514',
        constraint: 'wallet_ledger_entries_balanced',
      });
    });

    it('rejects a zero amount', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await expectViolation(
        () => addEntry(wallet, { amount: '0.00', balance_after: '100.00' }),
        { sqlState: '23514', constraint: 'wallet_ledger_entries_amount_positive' },
      );
    });

    it('rejects an unknown direction', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await expectViolation(() => addEntry(wallet, { direction: 'SIDEWAYS' }), {
        sqlState: '23514',
        constraint: 'wallet_ledger_entries_direction_valid',
      });
    });

    it('rejects a debit below zero', async () => {
      const wallet = await openWallet(db.app, '5.00');

      await expectViolation(
        () => addEntry(wallet, { balance_before: '5.00', balance_after: '-5.00' }),
        { sqlState: '23514', constraint: 'money_amount_non_negative' },
      );
    });
  });

  describe('chain: every entry continues the previous one', () => {
    it('rejects an entry whose balance_before is not the previous balance_after', async () => {
      const { wallet } = await walletWithOneDebit();

      await expectViolation(
        () =>
          addEntry(wallet, {
            balance_before: '100.00',
            balance_after: '90.00',
            wallet_version: 3,
          }),
        { sqlState: '23514', constraint: 'wallet_ledger_entries_chain' },
      );
    });

    it('rejects a gap in wallet versions', async () => {
      const { wallet } = await walletWithOneDebit();

      await expectViolation(
        () =>
          addEntry(wallet, { balance_before: '90.00', balance_after: '80.00', wallet_version: 4 }),
        { sqlState: '23514', constraint: 'wallet_ledger_entries_chain' },
      );
    });

    it('rejects a first entry that does not start from zero', async () => {
      const wallet = await openWallet(db.app, '0.00');

      await expectViolation(
        () =>
          addEntry(wallet, {
            direction: 'CREDIT',
            balance_before: '50.00',
            balance_after: '60.00',
            wallet_version: 2,
          }),
        { sqlState: '23514', constraint: 'wallet_ledger_entries_chain' },
      );
    });

    it('rejects an entry in another currency than its wallet', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await expectViolation(
        () =>
          addEntry(wallet, { currency: 'USD', balance_before: '100.00', balance_after: '90.00' }),
        { sqlState: '23514', constraint: 'wallet_ledger_entries_currency' },
      );
    });

    it('rejects a second entry for the same transaction and wallet', async () => {
      const wallet = await openWallet(db.app, '100.00');
      const bet = await applyMovement(db.app, wallet, {
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
        version: 2,
      });

      await expectViolation(
        () =>
          insert(
            db.app,
            'wallet_ledger_entries',
            ledgerRow(wallet, bet, {
              balance_before: '90.00',
              balance_after: '80.00',
              wallet_version: 3,
            }),
          ),
        { sqlState: '23505', constraint: 'wallet_ledger_entries_transaction_wallet_key' },
      );
    });
  });

  describe('replay', () => {
    it('rebuilding the balance from the ledger yields the stored balance', async () => {
      const wallet = await openWallet(db.app, '100.00');
      await applyMovement(db.app, wallet, {
        direction: 'DEBIT',
        amount: '30.00',
        balanceBefore: '100.00',
        balanceAfter: '70.00',
        version: 2,
      });
      await applyMovement(db.app, wallet, {
        direction: 'CREDIT',
        amount: '12.34',
        balanceBefore: '70.00',
        balanceAfter: '82.34',
        version: 3,
      });

      const [row] = await db.app`
        SELECT w.balance AS stored,
               COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS rebuilt
        FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ${wallet.id} GROUP BY w.balance`;

      expect(row).toEqual({ stored: '82.34', rebuilt: '82.34' });
    });
  });
});
