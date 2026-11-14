import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { httpObservability } from '../infrastructure/observability/http-observability';
import { JsonLogger, NestJsonLogger } from '../infrastructure/observability/json-logger';
import { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics';
import type { AppConfig } from '../config/load-config';
import { correlationIdMiddleware } from '../shared/interface/http/correlation-id';
import { RequestValidationError } from '../shared/interface/http/http-errors';

export interface HttpApplicationOptions {
  /** `false` silences Nest's bootstrap logs (tests). */
  readonly logger?: false;
}

/**
 * Single place that wires the HTTP application, shared by `main.ts` and the e2e tests so both
 * exercise exactly the same global setup: JSON logs, correlation ids, request metrics, schema
 * validation, Problem Details.
 */
export async function createHttpApplication(
  config: AppConfig,
  options: HttpApplicationOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    ...(options.logger === false ? { logger: false } : { bufferLogs: true }),
  });
  const logger = app.get(JsonLogger);
  if (options.logger !== false) app.useLogger(new NestJsonLogger(logger));
  app.use(correlationIdMiddleware);
  app.use(httpObservability(logger, app.get(PrometheusMetrics)));
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
