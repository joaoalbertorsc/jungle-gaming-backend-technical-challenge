/**
 * Migration runner: `bun run scripts/migrate.ts <up|down|pending>`.
 * Uses MIGRATION_DATABASE_URL (schema-owner role), never the runtime app role.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { migratorOptions } from '../src/infrastructure/database/migrator-options';

const COMMANDS = ['up', 'down', 'pending'] as const;
type Command = (typeof COMMANDS)[number];

function parseCommand(value: string | undefined): Command {
  const command = COMMANDS.find((candidate) => candidate === value);
  if (command === undefined) {
    throw new Error(`Usage: bun run scripts/migrate.ts <${COMMANDS.join('|')}>`);
  }
  return command;
}

async function run(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const url = process.env.MIGRATION_DATABASE_URL;
  if (url === undefined || url === '') throw new Error('MIGRATION_DATABASE_URL is required');

  const orm = await MikroORM.init(migratorOptions(url));
  try {
    if (command === 'up') {
      const applied = await orm.migrator.up();
      console.log(`Applied ${String(applied.length)} migration(s).`);
    } else if (command === 'down') {
      const reverted = await orm.migrator.down();
      console.log(`Reverted ${String(reverted.length)} migration(s).`);
    } else {
      const pending = await orm.migrator.getPending();
      console.log(
        pending.length === 0 ? 'No pending migrations.' : pending.map((m) => m.name).join('\n'),
      );
    }
  } finally {
    await orm.close(true);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
