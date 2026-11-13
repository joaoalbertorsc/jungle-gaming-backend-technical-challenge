import { describe, expect, it } from 'bun:test';
import { decideIdempotency } from '../../../../../src/modules/wagering/domain/idempotency';
import { WagerTransactionKind as Kind } from '../../../../../src/modules/wagering/domain/wager-transaction';
import { aWager } from '../../../../support/builders/wagering';

/** T-U5: an idempotency key reused with a divergent payload is a conflict, never a replay (§6.3, §9). */
describe('decideIdempotency', () => {
  it('treats an unseen key and external id as a new transaction', () => {
    expect(decideIdempotency(undefined, undefined, 'a'.repeat(64))).toEqual({ type: 'new' });
  });

  it('replays the stored transaction when the payload is identical', () => {
    const stored = aWager(Kind.Bet);

    expect(decideIdempotency(stored, stored, stored.payloadHash)).toEqual({
      type: 'replay',
      transaction: stored,
    });
  });

  it('is a conflict when the same key arrives with a divergent payload', () => {
    const stored = aWager(Kind.Bet);

    expect(decideIdempotency(stored, stored, 'f'.repeat(64))).toEqual({
      type: 'conflict',
      reason: 'PAYLOAD_MISMATCH',
    });
  });

  it('is a conflict when the provider reuses an external id under another key', () => {
    const storedUnderOtherKey = aWager(Kind.Bet);

    expect(
      decideIdempotency(undefined, storedUnderOtherKey, storedUnderOtherKey.payloadHash),
    ).toEqual({ type: 'conflict', reason: 'EXTERNAL_ID_REUSED' });
  });
});
