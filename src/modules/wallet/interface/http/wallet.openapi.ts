import { z } from 'zod';
import { moneyViewSchema } from '../../../../shared/interface/http/openapi';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';

/** Response schemas of the wallet endpoints (documentation, checked against real responses). */

const uuid = z.uuid().meta({ example: '0192f291-27dd-7d3f-8071-5f8685deef37' });
const timestamp = z.iso.datetime().meta({ example: '2026-11-14T15:00:00.000Z' });

export const walletViewSchema = z
  .object({
    id: uuid,
    playerId: z.string().meta({ example: 'player-1' }),
    balance: moneyViewSchema,
    version: z.number().int().min(0).meta({
      description: 'Increments with every balance change; equals the last ledger entry version',
      example: 1,
    }),
  })
  .strict()
  .meta({ title: 'Wallet' });

export const ledgerEntryViewSchema = z
  .object({
    id: uuid,
    transactionId: uuid,
    direction: z.enum(LedgerDirection),
    money: moneyViewSchema,
    balanceBefore: moneyViewSchema,
    balanceAfter: moneyViewSchema,
    walletVersion: z.number().int().min(1).meta({ example: 2 }),
    createdAt: timestamp,
  })
  .strict()
  .meta({ title: 'LedgerEntry' });

export const ledgerPageSchema = z
  .object({
    entries: z.array(ledgerEntryViewSchema).meta({ description: 'Newest first' }),
    nextCursor: z.string().nullable().meta({
      description: 'Opaque cursor for the next page (pass it as ?cursor=); null on the last page',
    }),
  })
  .strict()
  .meta({ title: 'LedgerPage' });

export const reconciliationReportSchema = z
  .object({
    walletId: uuid,
    storedBalance: moneyViewSchema,
    calculatedBalance: moneyViewSchema.meta({ description: 'Balance rebuilt from the ledger' }),
    difference: moneyViewSchema.meta({ description: 'storedBalance − calculatedBalance' }),
    consistent: z.boolean().meta({ example: true }),
    checkedEntries: z.number().int().min(0).meta({ example: 3 }),
  })
  .strict()
  .meta({ title: 'ReconciliationReport' });

export const CREATE_WALLET_EXAMPLES = {
  brl: {
    summary: 'Wallet with 100.00 BRL',
    value: { playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } },
  },
  empty: {
    summary: 'Empty wallet (no opening transaction)',
    value: { playerId: 'player-2', initialBalance: { amount: '0', currency: 'BRL' } },
  },
};
