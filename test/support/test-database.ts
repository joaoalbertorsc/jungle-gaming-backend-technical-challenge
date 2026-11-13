import { SQL } from 'bun';
import { createHash } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  MIGRATIONS_PATH,
  migratorOptions,
} from '../../src/infrastructure/database/migrator-options';
import { integrationEnv, uniqueRunId } from './integration-env';

/**
 * Per-test-file PostgreSQL databases (ADR-0017).
 *
 * A template database is migrated once (and again only when the migration files change), then every
 * test file clones it with `CREATE DATABASE ... TEMPLATE`, which is fast and fully isolated. Clones
 * keep the role grants applied by the migrations, so tests can connect as the runtime app role.
 */
const TEMPLATE_DATABASE = 'wagering_template';
const ADVISORY_LOCK_KEY = 74_201_607;

function onDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Maintenance connection as the schema owner (it has CREATEDB). */
function adminConnection(): SQL {
  return new SQL({ url: onDatabase(integrationEnv.migrationDatabaseUrl, 'postgres'), max: 1 });
}

async function migrationsFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  const files = [...new Bun.Glob('*.ts').scanSync(MIGRATIONS_PATH)].sort();
  for (const file of files) {
    hash.update(file).update(await Bun.file(`${MIGRATIONS_PATH}/${file}`).text());
  }
  return hash.digest('hex');
}

/** Applies every migration to an empty database with the real migrator configuration. */
export async function migrate(databaseUrl: string, direction: 'up' | 'down' = 'up'): Promise<void> {
  const options = migratorOptions(databaseUrl);
  const orm = await MikroORM.init({
    ...options,
    migrations: { ...options.migrations, silent: true },
  });
  try {
    if (direction === 'up') await orm.migrator.up();
    else await orm.migrator.down({ to: 0 });
  } finally {
    await orm.close(true);
  }
}

async function ensureTemplate(admin: SQL): Promise<void> {
  const fingerprint = await migrationsFingerprint();
  const rows: { fingerprint: string | null }[] = await admin`
    SELECT shobj_description(oid, 'pg_database') AS fingerprint
    FROM pg_database WHERE datname = ${TEMPLATE_DATABASE}`;
  if (rows[0]?.fingerprint === fingerprint) return;

  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  await migrate(onDatabase(integrationEnv.migrationDatabaseUrl, TEMPLATE_DATABASE));
  await admin.unsafe(`COMMENT ON DATABASE ${TEMPLATE_DATABASE} IS '${fingerprint}'`);
}

export class TestDatabase {
  private constructor(
    readonly name: string,
    /** Connection string for the runtime role (DML only). */
    readonly appUrl: string,
    /** Connection string for the schema owner. */
    readonly ownerUrl: string,
    /** Runtime role: what the application uses. */
    readonly app: SQL,
    /** Schema owner: used to prove that even the owner cannot break the invariants. */
    readonly owner: SQL,
  ) {}

  /** A fresh database cloned from the migrated template. */
  static async create(): Promise<TestDatabase> {
    const name = `test_${uniqueRunId()}`;
    await TestDatabase.withLock(async (admin) => {
      await ensureTemplate(admin);
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
    });
    return TestDatabase.connect(name);
  }

  /** A fresh database with no migrations applied (for migration tests). */
  static async createEmpty(): Promise<TestDatabase> {
    const name = `test_${uniqueRunId()}`;
    await TestDatabase.withLock(async (admin) => {
      await admin.unsafe(`CREATE DATABASE ${name}`);
    });
    return TestDatabase.connect(name);
  }

  async drop(): Promise<void> {
    await this.app.close();
    await this.owner.close();
    const admin = adminConnection();
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  }

  private static connect(name: string): TestDatabase {
    const appUrl = onDatabase(integrationEnv.databaseUrl, name);
    const ownerUrl = onDatabase(integrationEnv.migrationDatabaseUrl, name);
    return new TestDatabase(name, appUrl, ownerUrl, new SQL(appUrl), new SQL(ownerUrl));
  }

  /** Serializes template preparation and cloning across concurrent test processes. */
  private static async withLock(work: (admin: SQL) => Promise<void>): Promise<void> {
    const admin = adminConnection();
    try {
      await admin`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
      try {
        await work(admin);
      } finally {
        await admin`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
      }
    } finally {
      await admin.close();
    }
  }
}
