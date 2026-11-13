import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { migrate, TestDatabase } from '../../support/test-database';

/** §4: migrations are versioned and reversible. Runs the real migration files on an empty database. */
const TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

describe('migrations', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await TestDatabase.createEmpty();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function userTables(): Promise<string[]> {
    const rows: { name: string }[] = await db.owner`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
      ORDER BY table_name`;
    return rows.map((row) => row.name);
  }

  async function userObjects(): Promise<{ functions: number; domains: number }> {
    const [row] = await db.owner`
      SELECT
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public') AS functions,
        (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typtype = 'd') AS domains`;
    return row as { functions: number; domains: number };
  }

  it('up() creates every table', async () => {
    await migrate(db.ownerUrl, 'up');

    expect(await userTables()).toEqual(TABLES);
  });

  it('down() reverts everything: no tables, functions or domains are left behind', async () => {
    await migrate(db.ownerUrl, 'down');

    expect(await userTables()).toEqual([]);
    expect(await userObjects()).toEqual({ functions: 0, domains: 0 });
  });

  it('up() works again after a full rollback', async () => {
    await migrate(db.ownerUrl, 'up');

    expect(await userTables()).toEqual(TABLES);
  });
});
