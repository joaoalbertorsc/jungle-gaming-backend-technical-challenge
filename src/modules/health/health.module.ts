import { Module } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG } from '../../config/app-config.module';
import type { AppConfig } from '../../config/load-config';
import { MIKRO_ORM } from '../../infrastructure/database/database.module';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs.module';
import { HealthController } from './interface/http/health.controller';
import { ReadinessChecker } from './readiness';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: ReadinessChecker,
      useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig) =>
        new ReadinessChecker(orm, sqs, config.sqs.queues.wagerTransactions),
      inject: [MIKRO_ORM, SQS_CLIENT, APP_CONFIG],
    },
  ],
})
export class HealthModule {}
