import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createHttpApplication } from './bootstrap/create-http-application';
import { createWorkerApplication } from './bootstrap/create-worker-application';
import { type AppRole, loadConfig } from './config/load-config';

const logger = new Logger('Bootstrap');

/** Roles whose modules exist so far; the outbox relay and retry worker land in phases 6 and 7. */
const IMPLEMENTED_ROLES: readonly AppRole[] = ['api', 'consumer'];

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const pendingRoles = config.roles.filter((role) => !IMPLEMENTED_ROLES.includes(role));
  if (pendingRoles.length > 0) {
    throw new Error(`Roles not implemented yet: ${pendingRoles.join(', ')}`);
  }

  if (config.roles.includes('api')) {
    const app = await createHttpApplication(config);
    await app.listen(config.http.port, '0.0.0.0');
    logger.log(`roles [${config.roles.join(', ')}] up; HTTP on port ${String(config.http.port)}`);
  } else {
    await createWorkerApplication(config);
    logger.log(`roles [${config.roles.join(', ')}] up (no HTTP server)`);
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
