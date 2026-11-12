import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createHttpApplication } from './bootstrap/create-http-application';
import { loadConfig } from './config/load-config';

const logger = new Logger('Bootstrap');

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // Worker roles (consumer, outbox-relay, retry-worker) are added in later phases.
  const pendingRoles = config.roles.filter((role) => role !== 'api');
  if (pendingRoles.length > 0) {
    throw new Error(`Roles not implemented yet: ${pendingRoles.join(', ')}`);
  }

  const app = await createHttpApplication(config);
  await app.listen(config.http.port, '0.0.0.0');
  logger.log(`HTTP API listening on port ${String(config.http.port)}`);
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
