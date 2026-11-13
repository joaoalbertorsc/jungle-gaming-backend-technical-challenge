import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../../../src/modules/messaging/domain/inbox-message';
import { InvalidMessageStateError } from '../../../../../src/modules/messaging/domain/messaging-errors';

const T0 = new Date('2026-07-29T15:00:00.000Z');
const T1 = new Date('2026-07-29T15:00:01.000Z');

const receive = () =>
  InboxMessage.receive({
    messageId: 'msg-123',
    consumerName: 'wager-transactions',
    payloadHash: 'a'.repeat(64),
    receivedAt: T0,
  });

describe('InboxMessage', () => {
  it('is received unprocessed', () => {
    const message = receive();

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('is marked processed once', () => {
    const message = receive();

    message.markProcessed(T1);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T1);
  });

  it('refuses to be processed twice', () => {
    const message = receive();
    message.markProcessed(T1);

    expect(() => {
      message.markProcessed(T1);
    }).toThrow(InvalidMessageStateError);
  });

  it('detects a redelivered message id carrying a different payload', () => {
    const message = receive();

    expect(message.matchesPayload('a'.repeat(64))).toBe(true);
    expect(message.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it('rehydrates persisted state', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt: T0,
      processedAt: T1,
    });

    expect(message.isProcessed()).toBe(true);
  });
});
