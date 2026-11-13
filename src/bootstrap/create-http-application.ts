import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import type { AppConfig } from '../config/load-config';

/**
 * Single place that wires the HTTP application, shared by `main.ts` and the e2e tests
 * so both exercise exactly the same global setup.
 */
export async function createHttpApplication(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config));
  app.enableShutdownHooks();
  return app;
}
