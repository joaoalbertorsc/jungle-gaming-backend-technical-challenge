import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/load-config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Injectable()
class SqsShutdown implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

/** One SQS client per process (emulator endpoint locally, AWS resolution otherwise). */
@Global()
@Module({})
export class SqsModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: SqsModule,
      providers: [
        {
          provide: SQS_CLIENT,
          useFactory: () =>
            new SQSClient({ region: config.sqs.region, endpoint: config.sqs.endpoint }),
        },
        SqsShutdown,
      ],
      exports: [SQS_CLIENT],
    };
  }
}
