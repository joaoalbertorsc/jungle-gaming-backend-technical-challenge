import { z } from 'zod';
import { moneyViewSchema, problemDetailsSchema } from '../../../../shared/interface/http/openapi';
import { FailureCode } from '../../domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';

/** Response schemas and examples of the wagering endpoints. */

const uuid = z.uuid().meta({ example: '0192f2a4-81c3-7e1b-9d2f-3c4b5a697d81' });
const timestamp = z.iso.datetime().meta({ example: '2026-11-14T15:00:00.000Z' });
const failureCode = z.enum(FailureCode).meta({
  description: 'Why a transaction was rejected (422) or failed; stable taxonomy (ADR-0009)',
});

export const wagerOutcomeSchema = z
  .object({
    transactionId: uuid,
    status: z.enum(WagerTransactionStatus),
    failureCode: failureCode.optional(),
    balance: moneyViewSchema.meta({
      description: 'Balance observed when the outcome was decided; a replay returns the same value',
    }),
    idempotentReplay: z.boolean().meta({ description: 'true when answered from a stored outcome' }),
  })
  .strict()
  .meta({ title: 'WagerOutcome' });

export const wagerTransactionViewSchema = z
  .object({
    id: uuid,
    providerId: z.string().meta({ example: 'provider-a' }),
    externalTransactionId: z.string().meta({ example: 'bet-1001' }),
    idempotencyKey: z.string().meta({ example: 'provider-a:bet-1001' }),
    walletId: uuid,
    playerId: z.string().meta({ example: 'player-1' }),
    roundId: z.string().meta({ example: 'round-1' }),
    gameId: z.string().meta({ example: 'fortune-chimp' }),
    kind: z.enum(WagerTransactionKind),
    money: moneyViewSchema,
    referenceExternalTransactionId: z.string().optional(),
    referenceTransactionId: uuid.optional(),
    status: z.enum(WagerTransactionStatus),
    failureCode: failureCode.optional(),
    resultingBalance: moneyViewSchema.optional(),
    createdAt: timestamp,
    completedAt: timestamp.optional(),
  })
  .strict()
  .meta({ title: 'WagerTransaction' });

/** 422 is either a rejected outcome (failureCode) or a Problem (WALLET_NOT_FOUND, CURRENCY_MISMATCH). */
export const unprocessableSubmissionSchema = z.union([wagerOutcomeSchema, problemDetailsSchema]);

const WALLET_ID = 'paste-the-wallet-id-from-POST-/wallets';

function example(summary: string, value: Record<string, unknown>) {
  return {
    summary,
    value: {
      providerId: 'provider-a',
      playerId: 'player-1',
      walletId: WALLET_ID,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      ...value,
    },
  };
}

/**
 * One ready-to-send body per kind. They chain: send `bet` first, then the others reference it
 * (`rollback` reverses the WIN). Use `provider-a:{externalTransactionId}` as the Idempotency-Key.
 */
export const SUBMIT_WAGER_EXAMPLES = {
  bet: example('BET: debit 25.00', {
    externalTransactionId: 'bet-1001',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  }),
  win: example('WIN: credit 40.00 for the round BET', {
    externalTransactionId: 'win-1001',
    kind: 'WIN',
    money: { amount: '40.00', currency: 'BRL' },
    referenceExternalTransactionId: 'bet-1001',
  }),
  loss: example('LOSS: records the result, no balance change', {
    externalTransactionId: 'loss-1001',
    kind: 'LOSS',
    money: { amount: '0', currency: 'BRL' },
    referenceExternalTransactionId: 'bet-1001',
  }),
  refund: example('REFUND: credit back the BET (same amount)', {
    externalTransactionId: 'refund-1001',
    kind: 'REFUND',
    money: { amount: '25.00', currency: 'BRL' },
    referenceExternalTransactionId: 'bet-1001',
  }),
  rollback: example('ROLLBACK: reverse the WIN (debits it back)', {
    externalTransactionId: 'rollback-1001',
    kind: 'ROLLBACK',
    money: { amount: '40.00', currency: 'BRL' },
    referenceExternalTransactionId: 'win-1001',
  }),
};
