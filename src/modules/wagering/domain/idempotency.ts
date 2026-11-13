import type { WagerTransaction } from './wager-transaction';

export type IdempotencyDecision =
  | { readonly type: 'new' }
  | { readonly type: 'replay'; readonly transaction: WagerTransaction }
  | {
      readonly type: 'conflict';
      readonly reason: 'PAYLOAD_MISMATCH' | 'EXTERNAL_ID_REUSED';
    };

/**
 * The Idempotency-Key is the source of truth (§9, ADR-0008):
 * - same key, same payload hash → replay the stored outcome;
 * - same key, different payload → conflict, never a replay;
 * - new key but a (provider, external id) already stored under another key → conflict.
 */
export function decideIdempotency(
  storedByKey: WagerTransaction | undefined,
  storedByExternalId: WagerTransaction | undefined,
  payloadHash: string,
): IdempotencyDecision {
  if (storedByKey !== undefined) {
    return storedByKey.matchesPayload(payloadHash)
      ? { type: 'replay', transaction: storedByKey }
      : { type: 'conflict', reason: 'PAYLOAD_MISMATCH' };
  }
  if (storedByExternalId !== undefined) return { type: 'conflict', reason: 'EXTERNAL_ID_REUSED' };
  return { type: 'new' };
}
