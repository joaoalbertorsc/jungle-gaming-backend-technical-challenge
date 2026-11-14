import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  ApiBodyExamples,
  ApiCorrelationId,
  ApiProblems,
} from '../../../../shared/interface/http/openapi';
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
import {
  CREATE_WALLET_EXAMPLES,
  ledgerPageSchema,
  reconciliationReportSchema,
  walletViewSchema,
} from './wallet.openapi';

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

@ApiTags('Wallets')
@ApiCorrelationId()
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
  @ApiOperation({
    summary: 'Create a wallet',
    description:
      'One wallet per player and currency. A positive initial balance is credited through an ' +
      'internal OPENING transaction and its ledger entry, in the same SQL transaction.',
  })
  @ApiBodyExamples(CREATE_WALLET_EXAMPLES)
  @ApiResponse({ status: 201, description: 'Wallet created', standardSchema: walletViewSchema })
  @ApiProblems(400, 409, 503)
  create(
    @Body({ schema: createWalletSchema }) body: CreateWalletBody,
    @CorrelationId() correlationId: string,
  ): Promise<WalletView> {
    return this.createWallet.execute({ ...body, context: { correlationId, channel: 'http' } });
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get a wallet and its current balance' })
  @ApiResponse({ status: 200, description: 'The wallet', standardSchema: walletViewSchema })
  @ApiProblems(400, 404, 503)
  get(@Param('walletId', { schema: uuidSchema }) walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({
    summary: 'Browse the wallet ledger',
    description:
      'Append-only ledger in wallet-version order (oldest first), keyset-paginated: pass ' +
      '`nextCursor` back as `cursor`. ' +
      'Every balance change has exactly one entry; `walletVersion` has no gaps.',
  })
  @ApiResponse({
    status: 200,
    description: 'One page of entries',
    standardSchema: ledgerPageSchema,
  })
  @ApiProblems(400, 404, 503)
  ledger(
    @Param('walletId', { schema: uuidSchema }) walletId: string,
    @Query({ schema: ledgerQuerySchema }) query: LedgerQuery,
  ): Promise<LedgerPage> {
    return this.getLedger.execute({ walletId, cursor: query.cursor, limit: query.limit });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reconcile the balance with the ledger',
    description:
      'Rebuilds the balance from the ledger in one consistent snapshot and compares it with the ' +
      'stored balance. Read-only: it reports, it never corrects.',
  })
  @ApiResponse({
    status: 200,
    description: 'Reconciliation report',
    standardSchema: reconciliationReportSchema,
  })
  @ApiProblems(400, 404, 503)
  reconcile(
    @Param('walletId', { schema: uuidSchema }) walletId: string,
  ): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId);
  }
}
