import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/domain/canonical-json';
import { Money, type MoneyProps } from '../../../shared/domain/money';

/**
 * Business fields of a wager submission: the subset that defines "the same request" (ADR-0008).
 * The Idempotency-Key header and transport metadata (messageId, occurredAt) are not part of it.
 */
export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

/**
 * Canonical JSON (keys sorted recursively, no whitespace, absent reference omitted) of exactly the
 * business fields, with the amount normalized to 2 decimals. Extra properties are ignored.
 */
export function canonicalWagerPayload(payload: WagerPayload): string {
  return canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

/** payloadHash algorithm v1: lowercase hex SHA-256 of {@link canonicalWagerPayload}. */
export function computePayloadHash(payload: WagerPayload): string {
  return createHash('sha256').update(canonicalWagerPayload(payload), 'utf8').digest('hex');
}
