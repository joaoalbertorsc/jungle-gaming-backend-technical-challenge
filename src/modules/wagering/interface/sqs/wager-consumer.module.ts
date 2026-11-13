import {
  type BeforeApplicationShutdown,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG } from '../../../../config/app-config.module';
import type { AppConfig } from '../../../../config/load-config';
import { SQS_CLIENT } from '../../../../infrastructure/messaging/sqs.module';
import {
  APPLICATION_LOGGER,
  APPLICATION_METRICS,
  type ApplicationLogger,
  type ApplicationMetrics,
  CLOCK,
  type Clock,
  FAULT_INJECTOR,
  type FaultInjector,
} from '../../../../shared/application/ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../shared/application/unit-of-work';
import { ExponentialBackoff } from '../../../../shared/domain/exponential-backoff';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { WageringModule } from '../../wagering.module';
import { WagerTransactionConsumer } from './wager-transaction-consumer';

export const WAGER_CONSUMER_NAME = 'wager-transactions';

async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (QueueUrl === undefined) throw new Error(`queue ${name} not found`);
  return QueueUrl;
}

/** Starts polling once the application is up and drains before the database closes. */
@Injectable()
class ConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly consumer: WagerTransactionConsumer) {}

  onApplicationBootstrap(): void {
    this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}

/** The `consumer` role (ADR-0001, ADR-0010). */
@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: WagerTransactionConsumer,
      useFactory: async (
        config: AppConfig,
        sqs: SQSClient,
        submit: SubmitWagerTransaction,
        unitOfWork: UnitOfWork,
        clock: Clock,
        metrics: ApplicationMetrics,
        logger: ApplicationLogger,
        faults: FaultInjector,
      ) => {
        const settings = config.sqs.consumer;
        return new WagerTransactionConsumer({
          sqs,
          queueUrl: await queueUrl(sqs, config.sqs.queues.wagerTransactions),
          deadLetterQueueUrl: await queueUrl(sqs, config.sqs.queues.wagerTransactionsDlq),
          consumerName: WAGER_CONSUMER_NAME,
          submit,
          unitOfWork,
          clock,
          metrics,
          logger,
          faults,
          waitTimeSeconds: settings.waitTimeSeconds,
          maxMessages: settings.maxMessages,
          drainTimeoutMs: settings.drainTimeoutMs,
          retryBackoff: new ExponentialBackoff({
            baseMs: settings.retryBaseMs,
            factor: 2,
            maxMs: settings.retryMaxMs,
          }),
        });
      },
      inject: [
        APP_CONFIG,
        SQS_CLIENT,
        SubmitWagerTransaction,
        UNIT_OF_WORK,
        CLOCK,
        APPLICATION_METRICS,
        APPLICATION_LOGGER,
        FAULT_INJECTOR,
      ],
    },
    ConsumerLifecycle,
  ],
})
export class WagerConsumerModule {}
