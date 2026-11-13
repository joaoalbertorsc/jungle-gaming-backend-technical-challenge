import { Module } from '@nestjs/common';
import {
  APPLICATION_METRICS,
  type ApplicationMetrics,
  CLOCK,
  type Clock,
  FAULT_INJECTOR,
  type FaultInjector,
  ID_GENERATOR,
  type IdGenerator,
} from '../../shared/application/ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { GetWagerTransaction } from './application/wager-transaction-queries';
import { WagerTransactionsController } from './interface/http/wager-transactions.controller';

/** Use cases are plain classes; Nest builds them through factories (no decorators in application). */
@Module({
  controllers: [WagerTransactionsController],
  providers: [
    {
      provide: SubmitWagerTransaction,
      useFactory: (
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        faults: FaultInjector,
        metrics: ApplicationMetrics,
      ) => new SubmitWagerTransaction(unitOfWork, ids, clock, faults, metrics),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, FAULT_INJECTOR, APPLICATION_METRICS],
    },
    {
      provide: GetWagerTransaction,
      useFactory: (unitOfWork: UnitOfWork) => new GetWagerTransaction(unitOfWork),
      inject: [UNIT_OF_WORK],
    },
  ],
  exports: [SubmitWagerTransaction],
})
export class WageringModule {}
