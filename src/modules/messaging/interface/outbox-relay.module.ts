import {
  type BeforeApplicationShutdown,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG } from '../../../config/app-config.module';
import type { AppConfig } from '../../../config/load-config';
import { MIKRO_ORM } from '../../../infrastructure/database/database.module';
import { MikroOrmOutboxStore } from '../../../infrastructure/database/mikro-orm-outbox-store';
import { SqsEventPublisher } from '../../../infrastructure/messaging/sqs-event-publisher';
import { SQS_CLIENT } from '../../../infrastructure/messaging/sqs.module';
import {
  APPLICATION_LOGGER,
  APPLICATION_METRICS,
  type ApplicationLogger,
  type ApplicationMetrics,
  CLOCK,
  type Clock,
  FAULT_INJECTOR,
  type FaultInjector,
} from '../../../shared/application/ports';
import { ExponentialBackoff } from '../../../shared/domain/exponential-backoff';
import { OutboxRelay } from '../application/outbox-relay';

/** Starts the relay loop once the application is up and finishes its round before shutdown. */
@Injectable()
class RelayLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly relay: OutboxRelay) {}

  onApplicationBootstrap(): void {
    this.relay.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.relay.stop();
  }
}

/** The `outbox-relay` role (ADR-0001, ADR-0011); any number of instances may run. */
@Module({
  providers: [
    {
      provide: OutboxRelay,
      useFactory: async (
        config: AppConfig,
        orm: MikroORM,
        sqs: SQSClient,
        clock: Clock,
        metrics: ApplicationMetrics,
        logger: ApplicationLogger,
        faults: FaultInjector,
      ) => {
        const { QueueUrl } = await sqs.send(
          new GetQueueUrlCommand({ QueueName: config.sqs.queues.wageringEvents }),
        );
        if (QueueUrl === undefined) throw new Error('the events queue does not exist');
        const settings = config.outbox;
        return new OutboxRelay({
          store: new MikroOrmOutboxStore(orm),
          publisher: new SqsEventPublisher(sqs, QueueUrl),
          clock,
          metrics,
          logger,
          faults,
          batchSize: settings.batchSize,
          leaseMs: settings.leaseMs,
          pollIntervalMs: settings.pollIntervalMs,
          retryBackoff: new ExponentialBackoff({
            baseMs: settings.retryBaseMs,
            factor: 2,
            maxMs: settings.retryMaxMs,
          }),
        });
      },
      inject: [
        APP_CONFIG,
        MIKRO_ORM,
        SQS_CLIENT,
        CLOCK,
        APPLICATION_METRICS,
        APPLICATION_LOGGER,
        FAULT_INJECTOR,
      ],
    },
    RelayLifecycle,
  ],
})
export class OutboxRelayModule {}
