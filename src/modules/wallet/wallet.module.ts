import { Module } from '@nestjs/common';
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
} from '../../shared/application/ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work';
import { CreateWallet } from './application/create-wallet';
import { ReconcileWallet } from './application/reconcile-wallet';
import { GetWallet, GetWalletLedger } from './application/wallet-queries';
import { WalletsController } from './interface/http/wallets.controller';

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: CreateWallet,
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock, faults: FaultInjector) =>
        new CreateWallet(unitOfWork, ids, clock, faults),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, FAULT_INJECTOR],
    },
    {
      provide: GetWallet,
      useFactory: (unitOfWork: UnitOfWork) => new GetWallet(unitOfWork),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetWalletLedger,
      useFactory: (unitOfWork: UnitOfWork) => new GetWalletLedger(unitOfWork),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ReconcileWallet,
      useFactory: (
        unitOfWork: UnitOfWork,
        logger: ApplicationLogger,
        metrics: ApplicationMetrics,
      ) => new ReconcileWallet(unitOfWork, logger, metrics),
      inject: [UNIT_OF_WORK, APPLICATION_LOGGER, APPLICATION_METRICS],
    },
  ],
})
export class WalletModule {}
