import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { JsonLogger, NestJsonLogger } from '../infrastructure/observability/json-logger';
import type { AppConfig } from '../config/load-config';

/**
 * Application context without an HTTP server, for processes that only run worker roles
 * (consumer, outbox-relay, retry-worker). SIGTERM triggers the graceful shutdown hooks.
 */
export async function createWorkerApplication(
  config: AppConfig,
  options: { readonly logger?: false } = {},
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    ...(options.logger === false ? { logger: false } : { bufferLogs: true }),
  });
  if (options.logger !== false) app.useLogger(new NestJsonLogger(app.get(JsonLogger)));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
