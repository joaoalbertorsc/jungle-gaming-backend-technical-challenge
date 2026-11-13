import { describe, expect, it } from 'bun:test';
import {
  canonicalWagerPayload,
  computePayloadHash,
  type WagerPayload,
} from '../../../../../src/modules/wagering/domain/wager-payload';

/** The example message from the challenge (§10). */
const example: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

/** Independent oracle: Bun's native hasher, not the node:crypto code under test. */
const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

describe('payloadHash (algorithm v1)', () => {
  it('hashes the canonical JSON of the business fields: keys sorted, no whitespace', () => {
    const canonical = canonicalWagerPayload(example);

    expect(canonical).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
        '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
    expect(computePayloadHash(example)).toBe(sha256(canonical));
  });

  it('is a 64-character lowercase hex SHA-256 digest', () => {
    expect(computePayloadHash(example)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order in which fields arrive', () => {
    const reordered: WagerPayload = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: example.walletId,
      playerId: example.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(example));
  });

  it('normalizes the amount, so "25" and "25.00" are the same payload', () => {
    const unnormalized = { ...example, money: { amount: '25', currency: 'BRL' } };

    expect(computePayloadHash(unnormalized)).toBe(computePayloadHash(example));
  });

  it('treats an absent reference and an undefined reference identically', () => {
    expect(computePayloadHash({ ...example, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(example),
    );
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'another-player' }],
    ['walletId', { walletId: 'another-wallet' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'another-game' }],
    ['kind', { kind: 'WIN' }],
    ['money.amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['money.currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'transaction-100' }],
  ])('changes when %s changes', (_field, change) => {
    expect(computePayloadHash({ ...example, ...change })).not.toBe(computePayloadHash(example));
  });
});
