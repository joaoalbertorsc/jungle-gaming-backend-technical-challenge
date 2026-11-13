import { describe, expect, it } from 'bun:test';
import { classifyFailure } from '../../../../../../src/modules/wagering/interface/sqs/failure-classifier';
import { parseWagerMessage } from '../../../../../../src/modules/wagering/interface/sqs/wager-message';
import { InvalidWagerTransactionError } from '../../../../../../src/modules/wagering/domain/wagering-errors';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  UnknownWalletError,
} from '../../../../../../src/shared/application/application-errors';
import { InvalidMoneyError } from '../../../../../../src/shared/domain/errors';

/** The message shape of §10. */
const message = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

describe('parseWagerMessage', () => {
  it('accepts the challenge message and fingerprints it', () => {
    const parsed = parseWagerMessage(JSON.stringify(message));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message.data.idempotencyKey).toBe('provider-a:transaction-123');
    expect(parsed.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprints the content, not the formatting', () => {
    const compact = parseWagerMessage(JSON.stringify(message));
    const pretty = parseWagerMessage(JSON.stringify(message, null, 2));

    expect(compact.ok && pretty.ok && compact.payloadHash === pretty.payloadHash).toBe(true);
  });

  it('reports a body that is not JSON as MALFORMED_MESSAGE', () => {
    expect(parseWagerMessage('{not json')).toMatchObject({
      ok: false,
      reason: 'MALFORMED_MESSAGE',
    });
  });

  it.each([
    ['an unknown type', { ...message, type: 'SomethingElse' }],
    ['the internal OPENING kind', { ...message, data: { ...message.data, kind: 'OPENING' } }],
    [
      'a missing idempotency key',
      { ...message, data: { ...message.data, idempotencyKey: undefined } },
    ],
    [
      'a numeric amount',
      { ...message, data: { ...message.data, money: { amount: 25, currency: 'BRL' } } },
    ],
    ['an unknown field', { ...message, extra: true }],
  ])('reports %s as INVALID_MESSAGE', (_label, body) => {
    expect(parseWagerMessage(JSON.stringify(body))).toMatchObject({
      ok: false,
      reason: 'INVALID_MESSAGE',
    });
  });
});

/** §10: business errors are terminal (ack), transient ones are retried, permanent ones go to the DLQ. */
describe('classifyFailure', () => {
  it.each([
    [new InvalidWagerTransactionError('REFERENCE_REQUIRED', 'x'), 'dead-letter', 'INVALID_MESSAGE'],
    [new InvalidMoneyError('x'), 'dead-letter', 'INVALID_MESSAGE'],
    [new IdempotencyConflictError('PAYLOAD_MISMATCH'), 'dead-letter', 'IDEMPOTENCY_CONFLICT'],
    [new UnknownWalletError('w'), 'ack', 'WALLET_NOT_FOUND'],
    [new TransientInfrastructureError('LOCK_TIMEOUT'), 'retry', 'LOCK_TIMEOUT'],
    [new TransientInfrastructureError('DATABASE_UNAVAILABLE'), 'retry', 'DATABASE_UNAVAILABLE'],
    [new Error('boom'), 'retry', 'UNEXPECTED_ERROR'],
  ])('%s → %s (%s)', (error, action, reason) => {
    expect(classifyFailure(error)).toEqual({ action, reason } as ReturnType<
      typeof classifyFailure
    >);
  });
});
