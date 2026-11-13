import { expect } from 'bun:test';
import type { SQL } from 'bun';

/**
 * Raw-SQL fixtures for schema tests. They write rows exactly as the application will (one SQL
 * transaction per financial operation) so that each test can break one rule at a time.
 */
export const AT = '2026-07-29T15:00:00.000Z';

const short = () => Math.random().toString(36).slice(2, 10);
export const newId = (): string => Bun.randomUUIDv7();

export type Row = Record<string, string | number | null>;

export function walletRow(overrides: Row = {}): Row {
  return {
    id: newId(),
    player_id: `player-${short()}`,
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

export function transactionRow(wallet: Row, overrides: Row = {}): Row {
  const externalId = `ext-${short()}`;
  return {
    id: newId(),
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: wallet.id ?? null,
    player_id: wallet.player_id ?? null,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    status: 'PROCESSED',
    reference_transaction_id: null,
    failure_code: null,
    resulting_balance: '0.00',
    resulting_balance_currency: 'BRL',
    completed_at: AT,
    reference_attempts: 0,
    next_reference_attempt_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

export function ledgerRow(wallet: Row, transaction: Row, overrides: Row = {}): Row {
  return {
    id: newId(),
    wallet_id: wallet.id ?? null,
    transaction_id: transaction.id ?? null,
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '90.00',
    wallet_version: 2,
    created_at: AT,
    ...overrides,
  };
}

export async function insert(sql: SQL, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql(table)} ${sql(row)}`;
}

/** Opens a wallet the valid way: wallet + OPENING transaction + CREDIT entry, in one transaction. */
export async function openWallet(sql: SQL, balance: string, overrides: Row = {}): Promise<Row> {
  const wallet = walletRow({ balance, ...overrides });
  await sql.begin(async (tx) => {
    await insert(tx, 'wallets', wallet);
    if (balance === '0.00') return;
    const opening = transactionRow(wallet, {
      provider_id: 'internal',
      external_transaction_id: `opening:${String(wallet.id)}`,
      idempotency_key: `internal:opening:${String(wallet.id)}`,
      round_id: 'opening',
      game_id: 'opening',
      kind: 'OPENING',
      amount: balance,
      resulting_balance: balance,
    });
    await insert(tx, 'wager_transactions', opening);
    await insert(
      tx,
      'wallet_ledger_entries',
      ledgerRow(wallet, opening, {
        direction: 'CREDIT',
        amount: balance,
        balance_before: '0.00',
        balance_after: balance,
        wallet_version: 1,
      }),
    );
  });
  return wallet;
}

/**
 * Applies one movement the valid way: transaction + ledger entry + wallet update, one SQL transaction.
 * Returns the transaction row.
 */
export async function applyMovement(
  sql: SQL,
  wallet: Row,
  movement: {
    readonly direction: 'DEBIT' | 'CREDIT';
    readonly amount: string;
    readonly balanceBefore: string;
    readonly balanceAfter: string;
    readonly version: number;
    readonly transaction?: Row;
  },
): Promise<Row> {
  const transaction =
    movement.transaction ??
    transactionRow(wallet, {
      kind: movement.direction === 'DEBIT' ? 'BET' : 'WIN',
      amount: movement.amount,
      resulting_balance: movement.balanceAfter,
    });
  await sql.begin(async (tx) => {
    await insert(tx, 'wager_transactions', transaction);
    await insert(
      tx,
      'wallet_ledger_entries',
      ledgerRow(wallet, transaction, {
        direction: movement.direction,
        amount: movement.amount,
        balance_before: movement.balanceBefore,
        balance_after: movement.balanceAfter,
        wallet_version: movement.version,
      }),
    );
    await tx`UPDATE wallets SET balance = ${movement.balanceAfter}, version = ${movement.version}
             WHERE id = ${wallet.id}`;
  });
  return transaction;
}

interface ExpectedViolation {
  /** SQLSTATE, e.g. 23505 (unique), 23514 (check), 23503 (foreign key), 42501 (privilege). */
  readonly sqlState: string;
  /** Constraint, index or trigger-declared constraint name. */
  readonly constraint?: string;
}

/** Asserts that PostgreSQL itself rejected the action, with the expected SQLSTATE and constraint. */
export async function expectViolation(
  action: () => Promise<unknown>,
  expected: ExpectedViolation,
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error('expected PostgreSQL to reject the statement');

  const error = caught as { errno?: string; constraint?: string; message?: string };
  expect({ sqlState: error.errno, message: error.message }).toMatchObject({
    sqlState: expected.sqlState,
  });
  if (expected.constraint !== undefined) expect(error.constraint).toBe(expected.constraint);
}
