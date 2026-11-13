import { describe, expect, it } from 'bun:test';
import { InvalidMessageStateError } from '../../../../../src/modules/messaging/domain/messaging-errors';
import { OutboxMessage } from '../../../../../src/modules/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../../../../src/modules/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '../../../../../src/modules/wallet/domain/wallet';
import { ExponentialBackoff } from '../../../../../src/shared/domain/exponential-backoff';
import { brl, T0, T1 } from '../../../../support/builders/wagering';

function anEvent() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingCredit: { entryId: 'entry-0', transactionId: 'tx-0' },
    at: T0,
  });
  const entry = wallet.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('25.00'), at: T0 });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'event-1',
    correlationId: 'corr-1',
    occurredAt: T0,
  });
}

const seconds = (n: number) => new Date(T1.getTime() + n * 1000);

describe('OutboxMessage', () => {
  it('enqueues the serialized event envelope, due immediately', () => {
    const event = anEvent();

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(event.toJSON());
    expect(message.occurredAt).toEqual(T0);
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
  });

  it('is no longer pending or due once published', () => {
    const message = OutboxMessage.enqueue(anEvent());

    message.markPublished(T1);

    expect(message.publishedAt).toEqual(T1);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(seconds(60))).toBe(false);
  });

  it('refuses to be published twice', () => {
    const message = OutboxMessage.enqueue(anEvent());
    message.markPublished(T1);

    expect(() => {
      message.markPublished(T1);
    }).toThrow(InvalidMessageStateError);
  });

  it('schedules retries with exponential backoff', () => {
    const message = OutboxMessage.enqueue(anEvent());

    message.scheduleRetry(T1);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(seconds(1));
    expect(message.isDue(T1)).toBe(false);
    expect(message.isDue(seconds(1))).toBe(true);

    message.scheduleRetry(T1);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(seconds(2));
  });

  it('accepts a custom backoff policy', () => {
    const message = OutboxMessage.enqueue(anEvent());

    message.scheduleRetry(T1, new ExponentialBackoff({ baseMs: 10_000, factor: 3, maxMs: 60_000 }));

    expect(message.nextAttemptAt).toEqual(seconds(10));
  });

  it('refuses to schedule a retry for a published message', () => {
    const message = OutboxMessage.enqueue(anEvent());
    message.markPublished(T1);

    expect(() => {
      message.scheduleRetry(T1);
    }).toThrow(InvalidMessageStateError);
  });

  it('rehydrates persisted state', () => {
    const message = OutboxMessage.rehydrate({
      id: 'event-9',
      aggregateId: 'wallet-9',
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'event-9' },
      occurredAt: T0,
      attempts: 4,
      nextAttemptAt: seconds(30),
      publishedAt: undefined,
    });

    expect(message.attempts).toBe(4);
    expect(message.isDue(seconds(29))).toBe(false);
  });
});
