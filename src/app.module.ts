import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/app-config.module';
import type { AppConfig } from './config/load-config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { SystemModule } from './infrastructure/system/system.module';
import { HealthModule } from './modules/health/health.module';
import { OutboxRelayModule } from './modules/messaging/interface/outbox-relay.module';
import { RetryWorkerModule } from './modules/wagering/interface/retry-worker.module';
import { WagerConsumerModule } from './modules/wagering/interface/sqs/wager-consumer.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { ProblemDetailsFilter } from './shared/interface/http/problem-details.filter';

/**
 * One image, several roles (ADR-0001): the HTTP modules are always present (controllers stay idle
 * without an HTTP server); worker modules are added only for the roles this process runs.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const workers = [
      ...(config.roles.includes('consumer') ? [WagerConsumerModule] : []),
      ...(config.roles.includes('outbox-relay') ? [OutboxRelayModule] : []),
      ...(config.roles.includes('retry-worker') ? [RetryWorkerModule] : []),
    ];
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        SystemModule,
        DatabaseModule.forRoot(config),
        SqsModule.forRoot(config),
        HealthModule,
        WalletModule,
        WageringModule,
        ...workers,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
