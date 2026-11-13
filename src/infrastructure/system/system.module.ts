import { Global, Module } from '@nestjs/common';
import {
  APPLICATION_LOGGER,
  APPLICATION_METRICS,
  CLOCK,
  FAULT_INJECTOR,
  ID_GENERATOR,
} from '../../shared/application/ports';
import {
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
    { provide: FAULT_INJECTOR, useClass: NoFaults },
    { provide: APPLICATION_LOGGER, useClass: JsonConsoleLogger },
    { provide: APPLICATION_METRICS, useClass: NoopMetrics },
  ],
  exports: [CLOCK, ID_GENERATOR, FAULT_INJECTOR, APPLICATION_LOGGER, APPLICATION_METRICS],
})
export class SystemModule {}
