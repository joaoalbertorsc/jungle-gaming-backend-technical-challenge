import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { integrationEnv, uniqueRunId } from '../../support/integration-env';

/**
 * Spike (phase 0): proves MikroORM v7 runs on Bun and that reversible migrations
 * (hand-written SQL with up/down) work against a real PostgreSQL.
 * See docs/adr/0004-persistence-and-migrations.md.
 */
const runId = uniqueRunId();
const probeTable = `spike_probe_${runId}`;
const migrationsTable = `spike_migrations_${runId}`;

class CreateProbeTable extends Migration {
  override up(): void {
    this.addSql(`create table "${probeTable}" (id integer primary key)`);
  }

  override down(): void {
    this.addSql(`drop table "${probeTable}"`);
  }
}

async function tableExists(orm: MikroORM, table: string): Promise<boolean> {
  const rows = await orm.em
    .getConnection()
    .execute<{ exists: boolean }[]>('select to_regclass(?) is not null as exists', [table]);
  return rows[0]?.exists === true;
}

describe('MikroORM migrator on Bun (spike)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      clientUrl: integrationEnv.migrationDatabaseUrl,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      extensions: [Migrator],
      migrations: {
        tableName: migrationsTable,
        migrationsList: [{ name: 'CreateProbeTable', class: CreateProbeTable }],
        transactional: true,
        allOrNothing: true,
      },
    });
  });

  afterAll(async () => {
    await orm.em.getConnection().execute(`drop table if exists "${migrationsTable}"`);
    await orm.close(true);
  });

  it('reports the hand-written migration as pending before it runs', async () => {
    const pending = await orm.migrator.getPending();

    expect(pending.map((m) => m.name)).toEqual(['CreateProbeTable']);
  });

  it('applies the migration with up()', async () => {
    await orm.migrator.up();

    expect(await tableExists(orm, probeTable)).toBe(true);
    expect((await orm.migrator.getExecuted()).map((m) => m.name)).toEqual(['CreateProbeTable']);
  });

  it('reverts the migration with down()', async () => {
    await orm.migrator.down();

    expect(await tableExists(orm, probeTable)).toBe(false);
    expect(await orm.migrator.getExecuted()).toEqual([]);
  });
});
