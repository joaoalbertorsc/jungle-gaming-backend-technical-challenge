import { z } from 'zod';
import { identifierSchema, moneySchema, uuidSchema } from '../../../shared/interface/schemas';

/** Kinds a provider may submit; OPENING is internal (§6.3). */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

/**
 * Business payload of a wager submission: the HTTP body of POST /wagering/transactions and the
 * `data` of a WagerTransactionRequested SQS message (without its idempotencyKey) share it (§10).
 */
export const wagerTransactionPayloadSchema = z
  .object({
    providerId: identifierSchema,
    externalTransactionId: identifierSchema,
    playerId: identifierSchema,
    walletId: uuidSchema,
    roundId: identifierSchema,
    gameId: identifierSchema,
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: identifierSchema.optional(),
  })
  .strict();

export type WagerTransactionPayload = z.infer<typeof wagerTransactionPayloadSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(255);
