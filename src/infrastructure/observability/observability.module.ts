import {
  Controller,
  Get,
  Global,
  Header,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Registry } from 'prom-client';
import { APP_CONFIG } from '../../config/app-config.module';
import type { AppConfig } from '../../config/load-config';
import { APPLICATION_LOGGER, APPLICATION_METRICS } from '../../shared/application/ports';
import { MIKRO_ORM } from '../database/database.module';
import { SQS_CLIENT } from '../messaging/sqs.module';
import { DatabaseAndQueueBacklog } from './backlog-probe';
import { JsonLogger } from './json-logger';
import { PrometheusMetrics } from './prometheus-metrics';

/** GET /metrics on the API's own port (unauthenticated, like the health probes). */
@ApiTags('Observability')
@Controller()
class MetricsController {
  constructor(@Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics) {}

  @Get('metrics')
  @ApiOperation({
    summary: 'Prometheus metrics of this process',
    description: 'Catalogue in docs/observability.md. Worker processes serve it on METRICS_PORT.',
  })
  @ApiProduces('text/plain')
  @ApiResponse({
    status: 200,
    description: 'Prometheus text exposition format',
    schema: {
      type: 'string',
      example: 'wagering_transactions_total{kind="BET",status="PROCESSED",channel="http"} 3',
    },
  })
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  render(): Promise<string> {
    return this.metrics.render();
  }
}

/** Worker processes have no HTTP server: they serve /metrics on METRICS_PORT when it is set. */
@Injectable()
class WorkerMetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  onApplicationBootstrap(): void {
    const { port } = this.config.metrics;
    if (port === undefined || this.config.roles.includes('api')) return;
    this.server = Bun.serve({
      port,
      hostname: '0.0.0.0',
      fetch: async (request) =>
        new URL(request.url).pathname === '/metrics'
          ? new Response(await this.metrics.render(), {
              headers: { 'content-type': this.metrics.contentType },
            })
          : new Response('not found', { status: 404 }),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server?.stop(true);
    this.server = undefined;
  }
}

/** Logs and metrics for every role (§12): JSON logger, Prometheus registry, /metrics endpoints. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: JsonLogger,
      useFactory: (config: AppConfig) => new JsonLogger({ level: config.logLevel }),
      inject: [APP_CONFIG],
    },
    { provide: APPLICATION_LOGGER, useExisting: JsonLogger },
    {
      provide: PrometheusMetrics,
      useFactory: (config: AppConfig, orm: MikroORM, sqs: SQSClient) =>
        new PrometheusMetrics({
          backlog: new DatabaseAndQueueBacklog(orm, sqs, config.sqs.queues.wagerTransactionsDlq),
        }),
      inject: [APP_CONFIG, MIKRO_ORM, SQS_CLIENT],
    },
    { provide: APPLICATION_METRICS, useExisting: PrometheusMetrics },
    WorkerMetricsServer,
  ],
  exports: [JsonLogger, APPLICATION_LOGGER, PrometheusMetrics, APPLICATION_METRICS],
})
export class ObservabilityModule {}
