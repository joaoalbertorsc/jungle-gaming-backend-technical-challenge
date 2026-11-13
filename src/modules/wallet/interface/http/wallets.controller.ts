import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CorrelationId } from '../../../../shared/interface/http/correlation-id';
import { identifierSchema, moneySchema, uuidSchema } from '../../../../shared/interface/schemas';
import { CreateWallet } from '../../application/create-wallet';
import { ReconcileWallet, type ReconciliationReport } from '../../application/reconcile-wallet';
import {
  GetWallet,
  GetWalletLedger,
  LEDGER_PAGE_MAX,
  type LedgerPage,
} from '../../application/wallet-queries';
import type { WalletView } from '../../application/wallet-views';

const createWalletSchema = z
  .object({ playerId: identifierSchema, initialBalance: moneySchema })
  .strict();
type CreateWalletBody = z.infer<typeof createWalletSchema>;

const ledgerQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(LEDGER_PAGE_MAX).optional(),
  })
  .strict();
type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getLedger: GetWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @Body({ schema: createWalletSchema }) body: CreateWalletBody,
    @CorrelationId() correlationId: string,
  ): Promise<WalletView> {
    return this.createWallet.execute({ ...body, context: { correlationId, channel: 'http' } });
  }

  @Get(':walletId')
  get(@Param('walletId', { schema: uuidSchema }) walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', { schema: uuidSchema }) walletId: string,
    @Query({ schema: ledgerQuerySchema }) query: LedgerQuery,
  ): Promise<LedgerPage> {
    return this.getLedger.execute({ walletId, cursor: query.cursor, limit: query.limit });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId', { schema: uuidSchema }) walletId: string,
  ): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId);
  }
}
