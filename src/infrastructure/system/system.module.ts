import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module';
import type { AppConfig } from '../../config/load-config';
import {
  APPLICATION_LOGGER,
  APPLICATION_METRICS,
  CLOCK,
  FAULT_INJECTOR,
  ID_GENERATOR,
} from '../../shared/application/ports';
import {
  CrashAt,
  JsonConsoleLogger,
  NoFaults,
  NoopMetrics,
  SystemClock,
  UuidV7Generator,
} from './system-adapters';

/** Production adapters for the cross-cutting application ports. */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      // NoFaults in production; config refuses FAULT_CRASH_AT outside NODE_ENV=test.
      provide: FAULT_INJECTOR,
      useFactory: ({ faults }: AppConfig) =>
        faults.crashAt === undefined ? new NoFaults() : new CrashAt(faults.crashAt),
      inject: [APP_CONFIG],
    },
    { provide: APPLICATION_LOGGER, useClass: JsonConsoleLogger },
    { provide: APPLICATION_METRICS, useClass: NoopMetrics },
  ],
  exports: [CLOCK, ID_GENERATOR, FAULT_INJECTOR, APPLICATION_LOGGER, APPLICATION_METRICS],
})
export class SystemModule {}
