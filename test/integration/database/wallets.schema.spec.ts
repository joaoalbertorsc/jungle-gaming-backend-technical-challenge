import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  applyMovement,
  expectViolation,
  insert,
  ledgerRow,
  openWallet,
  transactionRow,
  walletRow,
} from '../../support/sql-fixtures';
import { TestDatabase } from '../../support/test-database';

/** §5.9 / ADR-0006: wallet invariants enforced by PostgreSQL, not only by the application. */
describe('schema: wallets', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await TestDatabase.create();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('valid writes (as the runtime app role)', () => {
    it('opens a wallet with its OPENING credit in the same transaction', async () => {
      const wallet = await openWallet(db.app, '100.00');

      const rows = await db.app`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
      expect(rows).toEqual([{ balance: '100.00', version: 1 }]);
    });

    it('opens a zero-balance wallet without any ledger entry', async () => {
      await openWallet(db.app, '0.00');
    });

    it('applies a movement: ledger entry + version bump + new balance', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await applyMovement(db.app, wallet, {
        direction: 'DEBIT',
        amount: '25.00',
        balanceBefore: '100.00',
        balanceAfter: '75.00',
        version: 2,
      });

      const rows = await db.app`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
      expect(rows).toEqual([{ balance: '75.00', version: 2 }]);
    });

    it('allows the same player to hold wallets in different currencies', async () => {
      const brl = await openWallet(db.app, '0.00');

      await openWallet(db.app, '0.00', { player_id: brl.player_id ?? null, currency: 'USD' });
    });
  });

  describe('uniqueness and value constraints', () => {
    it('rejects a second wallet for the same player and currency', async () => {
      const wallet = await openWallet(db.app, '0.00');

      await expectViolation(
        () => insert(db.app, 'wallets', walletRow({ player_id: wallet.player_id ?? null })),
        { sqlState: '23505', constraint: 'wallets_player_currency_key' },
      );
    });

    it('rejects a negative balance', async () => {
      await expectViolation(() => insert(db.app, 'wallets', walletRow({ balance: '-0.01' })), {
        sqlState: '23514',
        constraint: 'money_amount_non_negative',
      });
    });

    it('rejects a third decimal instead of rounding it', async () => {
      await expectViolation(() => insert(db.app, 'wallets', walletRow({ balance: '1.005' })), {
        sqlState: '23514',
        constraint: 'money_amount_max_scale',
      });
    });

    it('rejects amounts beyond 17 integer digits', async () => {
      await expectViolation(
        () => insert(db.app, 'wallets', walletRow({ balance: '100000000000000000.00' })),
        { sqlState: '23514', constraint: 'money_amount_max_precision' },
      );
    });

    it('rejects a currency that is not an ISO-4217 code', async () => {
      await expectViolation(() => insert(db.app, 'wallets', walletRow({ currency: 'brl' })), {
        sqlState: '23514',
        constraint: 'currency_code_format',
      });
    });

    it('rejects a version below 1', async () => {
      await expectViolation(() => insert(db.app, 'wallets', walletRow({ version: 0 })), {
        sqlState: '23514',
        constraint: 'wallets_version_positive',
      });
    });
  });

  describe('balance and ledger stay consistent (checked at commit)', () => {
    it('rejects a positive opening balance without its OPENING ledger entry', async () => {
      await expectViolation(
        () =>
          db.app.begin(async (tx) => {
            await insert(tx, 'wallets', walletRow({ balance: '100.00' }));
          }),
        { sqlState: '23514', constraint: 'wallets_balance_matches_ledger' },
      );
    });

    it('rejects a balance change whose ledger entry is missing', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await expectViolation(
        () =>
          db.app.begin(async (tx) => {
            await tx`UPDATE wallets SET balance = '90.00', version = 2 WHERE id = ${wallet.id}`;
          }),
        { sqlState: '23514', constraint: 'wallets_balance_matches_ledger' },
      );
    });

    it('rejects a balance that differs from the ledger entry of its version', async () => {
      const wallet = await openWallet(db.app, '100.00');
      const bet = transactionRow(wallet);

      await expectViolation(
        () =>
          db.app.begin(async (tx) => {
            await insert(tx, 'wager_transactions', bet);
            await insert(tx, 'wallet_ledger_entries', ledgerRow(wallet, bet));
            await tx`UPDATE wallets SET balance = '50.00', version = 2 WHERE id = ${wallet.id}`;
          }),
        { sqlState: '23514', constraint: 'wallets_balance_matches_ledger' },
      );
    });

    it('rejects a balance change without a version increment', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await expectViolation(
        () => db.app`UPDATE wallets SET balance = '90.00' WHERE id = ${wallet.id}`,
        { sqlState: '23514', constraint: 'wallets_version_tracks_balance' },
      );
    });

    it('rejects a version increment without a balance change', async () => {
      const wallet = await openWallet(db.app, '100.00');

      await expectViolation(() => db.app`UPDATE wallets SET version = 2 WHERE id = ${wallet.id}`, {
        sqlState: '23514',
        constraint: 'wallets_version_tracks_balance',
      });
    });
  });

  describe('immutability', () => {
    it.each(['player_id', 'currency', 'created_at'])('rejects changing %s', async (column) => {
      const wallet = await openWallet(db.app, '0.00');
      const value = column === 'currency' ? 'USD' : column === 'created_at' ? '2030-01-01' : 'x';

      await expectViolation(
        () => db.app`UPDATE wallets SET ${db.app(column)} = ${value} WHERE id = ${wallet.id}`,
        { sqlState: '23514', constraint: 'wallets_immutable_columns' },
      );
    });

    it('rejects deleting a wallet, even for the schema owner', async () => {
      const wallet = await openWallet(db.app, '0.00');

      await expectViolation(() => db.owner`DELETE FROM wallets WHERE id = ${wallet.id}`, {
        sqlState: '23514',
        constraint: 'wallets_no_delete',
      });
    });

    it('does not grant DELETE on wallets to the runtime role', async () => {
      const wallet = await openWallet(db.app, '0.00');

      await expectViolation(() => db.app`DELETE FROM wallets WHERE id = ${wallet.id}`, {
        sqlState: '42501',
      });
    });
  });
});
