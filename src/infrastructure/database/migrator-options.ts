import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';

export const MIGRATIONS_PATH = 'src/infrastructure/database/migrations';

/**
 * Options for running migrations with the schema-owner role (ADR 0004).
 * Migrations are hand-written SQL with explicit up/down, so schema snapshots are disabled.
 */
export function migratorOptions(clientUrl: string): Options {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    // Bun executes TypeScript natively, so migrations are loaded straight from the .ts sources.
    preferTs: true,
    migrations: {
      path: MIGRATIONS_PATH,
      pathTs: MIGRATIONS_PATH,
      glob: '!(*.d).ts',
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
