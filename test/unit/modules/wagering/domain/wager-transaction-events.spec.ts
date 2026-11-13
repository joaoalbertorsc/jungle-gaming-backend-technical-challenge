import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../../../src/modules/wagering/domain/events/wager-transaction-events';
import { FailureCode } from '../../../../../src/modules/wagering/domain/failure-code';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { InvalidTransactionStateError } from '../../../../../src/modules/wagering/domain/wagering-errors';
import { aWager, brl, T1 } from '../../../../support/builders/wagering';

const context = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: T1,
};

describe('wager transaction events', () => {
  it('WagerTransactionProcessed carries the outcome and the resulting balance', () => {
    const refund = aWager(Kind.Refund, { money: brl('25.00') });
    refund.markProcessed({
      referenceTransactionId: 'tx-bet',
      resultingBalance: brl('1000.00'),
      at: T1,
    });

    const envelope = WagerTransactionProcessed.from(refund, context).toJSON();

    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.version).toBe(1);
    expect(envelope.aggregateId).toBe(refund.id);
    expect(envelope.causationId).toBe('msg-1');
    expect(envelope.data).toEqual({
      transactionId: refund.id,
      providerId: refund.providerId,
      externalTransactionId: refund.externalTransactionId,
      playerId: refund.playerId,
      walletId: refund.walletId,
      roundId: refund.roundId,
      gameId: refund.gameId,
      kind: 'REFUND',
      status: Status.Processed,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-referenced',
      referenceTransactionId: 'tx-bet',
      balance: { amount: '1000.00', currency: 'BRL' },
      processedAt: T1.toISOString(),
    });
  });

  it('WagerTransactionProcessed is also emitted for LOSS, which moves no money', () => {
    const loss = aWager(Kind.Loss);
    loss.markProcessed({
      referenceTransactionId: undefined,
      resultingBalance: brl('975.00'),
      at: T1,
    });

    const data = WagerTransactionProcessed.from(loss, context).toJSON().data;

    expect(data.kind).toBe('LOSS');
    expect('referenceTransactionId' in data).toBe(false);
  });

  it('WagerTransactionRejected carries the failure code', () => {
    const bet = aWager(Kind.Bet);
    bet.reject({
      failureCode: FailureCode.InsufficientFunds,
      resultingBalance: brl('20.00'),
      at: T1,
    });

    const envelope = WagerTransactionRejected.from(bet, context).toJSON();

    expect(envelope.eventType).toBe('WagerTransactionRejected');
    expect(envelope.data.status).toBe(Status.Rejected);
    expect(envelope.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(envelope.data.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(envelope.data.rejectedAt).toBe(T1.toISOString());
  });

  it('WagerTransactionPendingReference names the missing reference', () => {
    const rollback = aWager(Kind.Rollback);
    rollback.markPendingReference({ observedBalance: brl('50.00') });

    const envelope = WagerTransactionPendingReference.from(rollback, context).toJSON();

    expect(envelope.eventType).toBe('WagerTransactionPendingReference');
    expect(envelope.data.status).toBe(Status.PendingReference);
    expect(envelope.data.referenceExternalTransactionId).toBe('ext-referenced');
  });

  it.each([
    ['WagerTransactionProcessed', () => WagerTransactionProcessed.from(aWager(Kind.Bet), context)],
    ['WagerTransactionRejected', () => WagerTransactionRejected.from(aWager(Kind.Bet), context)],
    [
      'WagerTransactionPendingReference',
      () => WagerTransactionPendingReference.from(aWager(Kind.Refund), context),
    ],
  ])('%s refuses a transaction in another status', (_event, build) => {
    expect(build).toThrow(InvalidTransactionStateError);
  });
});
