import { z } from 'zod';

/**
 * Transport-level schemas shared by HTTP and SQS (ADR-0009). They check shape and bounds only; the
 * domain still owns the business rules (e.g. Money's decimal format, reference requirements).
 */
export const identifierSchema = z.string().trim().min(1).max(128);

export const uuidSchema = z.uuid();

export const moneySchema = z
  .object({
    amount: z.string().max(32),
    currency: z.string().max(8),
  })
  .strict();
