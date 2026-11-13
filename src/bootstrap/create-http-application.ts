import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import type { AppConfig } from '../config/load-config';
import { correlationIdMiddleware } from '../shared/interface/http/correlation-id';
import { RequestValidationError } from '../shared/interface/http/http-errors';

export interface HttpApplicationOptions {
  /** `false` silences Nest's bootstrap logs (tests). */
  readonly logger?: false;
}

/**
 * Single place that wires the HTTP application, shared by `main.ts` and the e2e tests so both
 * exercise exactly the same global setup: correlation ids, schema validation, Problem Details.
 */
export async function createHttpApplication(
  config: AppConfig,
  options: HttpApplicationOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    ...(options.logger === false ? { logger: false } : {}),
  });
  app.use(correlationIdMiddleware);
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new RequestValidationError(
          issues.map((issue) => ({
            path: (issue.path ?? [])
              .map((segment) => (typeof segment === 'object' ? segment.key : segment))
              .map(String)
              .join('.'),
            message: issue.message,
          })),
        ),
    }),
  );
  app.enableShutdownHooks();
  return app;
}
