import {
  type BeforeApplicationShutdown,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG } from '../../../config/app-config.module';
import type { AppConfig } from '../../../config/load-config';
import { MIKRO_ORM } from '../../../infrastructure/database/database.module';
import { MikroOrmPendingReferenceQueue } from '../../../infrastructure/database/mikro-orm-pending-reference-queue';
import {
  APPLICATION_LOGGER,
  APPLICATION_METRICS,
  type ApplicationLogger,
  type ApplicationMetrics,
  CLOCK,
  type Clock,
  FAULT_INJECTOR,
  type FaultInjector,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../shared/application/ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/application/unit-of-work';
import { RetryPendingReferences } from '../application/retry-pending-references';
import { referenceRetryPolicy } from './reference-retry-policy';

/** Starts the worker loop once the application is up and finishes its round before shutdown. */
@Injectable()
class RetryWorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly worker: RetryPendingReferences) {}

  onApplicationBootstrap(): void {
    this.worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}

/** The `retry-worker` role (ADR-0001, ADR-0012); any number of instances may run. */
@Module({
  providers: [
    {
      provide: RetryPendingReferences,
      useFactory: (
        config: AppConfig,
        orm: MikroORM,
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        metrics: ApplicationMetrics,
        logger: ApplicationLogger,
        faults: FaultInjector,
      ) => {
        const settings = config.referenceRetry;
        return new RetryPendingReferences({
          queue: new MikroOrmPendingReferenceQueue(orm),
          unitOfWork,
          ids,
          clock,
          metrics,
          logger,
          faults,
          policy: referenceRetryPolicy(settings),
          batchSize: settings.batchSize,
          leaseMs: settings.leaseMs,
          pollIntervalMs: settings.pollIntervalMs,
        });
      },
      inject: [
        APP_CONFIG,
        MIKRO_ORM,
        UNIT_OF_WORK,
        ID_GENERATOR,
        CLOCK,
        APPLICATION_METRICS,
        APPLICATION_LOGGER,
        FAULT_INJECTOR,
      ],
    },
    RetryWorkerLifecycle,
  ],
})
export class RetryWorkerModule {}
