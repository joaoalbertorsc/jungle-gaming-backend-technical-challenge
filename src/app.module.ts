import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/app-config.module';
import type { AppConfig } from './config/load-config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { SystemModule } from './infrastructure/system/system.module';
import { HealthModule } from './modules/health/health.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { ProblemDetailsFilter } from './shared/interface/http/problem-details.filter';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
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
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
