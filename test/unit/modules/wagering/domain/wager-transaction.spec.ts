import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../../../src/modules/wagering/domain/failure-code';
import { computePayloadHash } from '../../../../../src/modules/wagering/domain/wager-payload';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../../../src/modules/wagering/domain/wagering-errors';
import { LedgerDirection } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { aProcessedWager, aWager, brl, T0, T1, wagerProps } from '../../../../support/builders/wagering';

function rejectionReason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidWagerTransactionError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('WagerTransaction', () => {
  describe('create()', () => {
    it('starts PENDING with no outcome yet', () => {
      const transaction = aWager(Kind.Bet);

      expect(transaction.status).toBe(Status.Pending);
      expect(transaction.failureCode).toBeUndefined();
      expect(transaction.processedAt).toBeUndefined();
      expect(transaction.resultingBalance).toBeUndefined();
      expect(transaction.isTerminal()).toBe(false);
    });

    it('stores the hash of its own business payload', () => {
      const props = wagerProps(Kind.Bet);
      const transaction = WagerTransaction.create(props);

      expect(transaction.payloadHash).toBe(computePayloadHash(transaction.payload()));
      expect(transaction.payload()).toEqual({
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        playerId: props.playerId,
        walletId: props.walletId,
        roundId: props.roundId,
        gameId: props.gameId,
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: undefined,
      });
    });

    it('refuses OPENING: it is internal and cannot be submitted', () => {
      expect(rejectionReason(() => aWager(Kind.Opening))).toBe('OPENING_NOT_SUBMITTABLE');
    });

    it('refuses the reserved internal provider id', () => {
      expect(rejectionReason(() => aWager(Kind.Bet, { providerId: INTERNAL_PROVIDER_ID }))).toBe(
        'RESERVED_PROVIDER',
      );
    });

    it.each([Kind.Refund, Kind.Rollback])('%s requires referenceExternalTransactionId', (kind) => {
      expect(
        rejectionReason(() => aWager(kind, { referenceExternalTransactionId: undefined })),
      ).toBe('REFERENCE_REQUIRED');
    });

    it('refuses a reference on a BET', () => {
      expect(
        rejectionReason(() => aWager(Kind.Bet, { referenceExternalTransactionId: 'ext-0' })),
      ).toBe('REFERENCE_NOT_ALLOWED');
    });

    it.each([Kind.Win, Kind.Loss])('%s may optionally reference the round BET', (kind) => {
      expect(aWager(kind, { referenceExternalTransactionId: 'ext-bet' }).hasReference()).toBe(true);
      expect(aWager(kind).hasReference()).toBe(false);
    });

    it('refuses a transaction that references itself', () => {
      expect(
        rejectionReason(() =>
          aWager(Kind.Refund, {
            externalTransactionId: 'ext-same',
            referenceExternalTransactionId: 'ext-same',
          }),
        ),
      ).toBe('SELF_REFERENCE');
    });

    it.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])(
      '%s requires a positive amount',
      (kind) => {
        expect(rejectionReason(() => aWager(kind, { money: brl('0.00') }))).toBe(
          'AMOUNT_MUST_BE_POSITIVE',
        );
      },
    );

    it('accepts a zero amount on LOSS, which moves no money', () => {
      expect(aWager(Kind.Loss, { money: brl('0.00') }).money.isZero()).toBe(true);
    });

    it.each(['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'])(
      'refuses an empty %s',
      (field) => {
        expect(rejectionReason(() => aWager(Kind.Bet, { [field]: ' ' }))).toBe('MISSING_FIELD');
      },
    );
  });

  describe('opening()', () => {
    it('creates the internal OPENING credit, already PROCESSED', () => {
      const opening = WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        at: T0,
      });

      expect(opening.kind).toBe(Kind.Opening);
      expect(opening.providerId).toBe(INTERNAL_PROVIDER_ID);
      expect(opening.status).toBe(Status.Processed);
      expect(opening.resultingBalance?.amount).toBe('1000.00');
      expect(opening.processedAt).toEqual(T0);
      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('state machine', () => {
    it('PENDING → PROCESSED records reference, resulting balance and time', () => {
      const transaction = aWager(Kind.Refund);

      transaction.markProcessed({
        referenceTransactionId: 'tx-bet',
        resultingBalance: brl('100.00'),
        at: T1,
      });

      expect(transaction.status).toBe(Status.Processed);
      expect(transaction.referenceTransactionId).toBe('tx-bet');
      expect(transaction.resultingBalance?.amount).toBe('100.00');
      expect(transaction.processedAt).toEqual(T1);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('PENDING → REJECTED records the failure code and the observed balance', () => {
      const transaction = aWager(Kind.Bet);

      transaction.reject({
        failureCode: FailureCode.InsufficientFunds,
        resultingBalance: brl('20.00'),
        at: T1,
      });

      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.resultingBalance?.amount).toBe('20.00');
      expect(transaction.completedAt).toEqual(T1);
      expect(transaction.processedAt).toBeUndefined();
    });

    it('PENDING → FAILED records a permanent infrastructure failure', () => {
      const transaction = aWager(Kind.Bet);

      transaction.fail({ failureCode: FailureCode.ProcessingFailed, at: T1 });

      expect(transaction.status).toBe(Status.Failed);
      expect(transaction.failureCode).toBe(FailureCode.ProcessingFailed);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('PENDING → PENDING_REFERENCE keeps the balance observed on arrival', () => {
      const transaction = aWager(Kind.Rollback);

      transaction.markPendingReference({ observedBalance: brl('50.00') });

      expect(transaction.status).toBe(Status.PendingReference);
      expect(transaction.resultingBalance?.amount).toBe('50.00');
      expect(transaction.isTerminal()).toBe(false);
    });

    it.each([
      ['PROCESSED', (t: WagerTransaction) => t.markProcessed({ referenceTransactionId: 'tx-bet', resultingBalance: brl('1.00'), at: T1 })],
      ['REJECTED', (t: WagerTransaction) => t.reject({ failureCode: FailureCode.ReferenceNotFound, resultingBalance: brl('1.00'), at: T1 })],
      ['FAILED', (t: WagerTransaction) => t.fail({ failureCode: FailureCode.ProcessingFailed, at: T1 })],
    ])('PENDING_REFERENCE → %s', (expected, transition) => {
      const transaction = aWager(Kind.Refund);
      transaction.markPendingReference({ observedBalance: brl('1.00') });

      transition(transaction);

      expect(transaction.status).toBe(expected as Status);
    });

    it('PENDING_REFERENCE cannot be marked pending again', () => {
      const transaction = aWager(Kind.Refund);
      transaction.markPendingReference({ observedBalance: brl('1.00') });

      expect(() => transaction.markPendingReference({ observedBalance: brl('1.00') })).toThrow(
        InvalidTransactionStateError,
      );
    });

    describe('terminal states never change', () => {
      const terminalTransactions: [string, () => WagerTransaction][] = [
        ['PROCESSED', () => aProcessedWager(Kind.Bet)],
        [
          'REJECTED',
          () => {
            const t = aWager(Kind.Bet);
            t.reject({ failureCode: FailureCode.InsufficientFunds, resultingBalance: brl('0.00'), at: T1 });
            return t;
          },
        ],
        [
          'FAILED',
          () => {
            const t = aWager(Kind.Bet);
            t.fail({ failureCode: FailureCode.ProcessingFailed, at: T1 });
            return t;
          },
        ],
      ];
      const transitions: [string, (t: WagerTransaction) => void][] = [
        ['markProcessed', (t) => { t.markProcessed({ referenceTransactionId: undefined, resultingBalance: brl('1.00'), at: T1 }); }],
        ['markPendingReference', (t) => { t.markPendingReference({ observedBalance: brl('1.00') }); }],
        ['reject', (t) => { t.reject({ failureCode: FailureCode.AmountMismatch, resultingBalance: brl('1.00'), at: T1 }); }],
        ['fail', (t) => { t.fail({ failureCode: FailureCode.ProcessingFailed, at: T1 }); }],
      ];

      for (const [state, build] of terminalTransactions) {
        for (const [name, transition] of transitions) {
          it(`${state} refuses ${name}`, () => {
            const transaction = build();
            const statusBefore = transaction.status;

            expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
            expect(transaction.status).toBe(statusBefore);
          });
        }
      }
    });
  });

  describe('domain queries', () => {
    it('affectsBalance() is false only for LOSS', () => {
      expect(aWager(Kind.Loss).affectsBalance()).toBe(false);
      for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
        expect(aWager(kind).affectsBalance()).toBe(true);
      }
    });

    it('requiresReference() is true only for REFUND and ROLLBACK', () => {
      expect(aWager(Kind.Refund).requiresReference()).toBe(true);
      expect(aWager(Kind.Rollback).requiresReference()).toBe(true);
      expect(aWager(Kind.Bet).requiresReference()).toBe(false);
      expect(aWager(Kind.Win).requiresReference()).toBe(false);
      expect(aWager(Kind.Loss).requiresReference()).toBe(false);
    });

    it('matchesPayload() compares payload hashes', () => {
      const transaction = aWager(Kind.Bet);

      expect(transaction.matchesPayload(transaction.payloadHash)).toBe(true);
      expect(transaction.matchesPayload('0'.repeat(64))).toBe(false);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Debit],
      [Kind.Win, LedgerDirection.Credit],
      [Kind.Refund, LedgerDirection.Credit],
    ])('ledgerDirectionFor(): %s → %s', (kind, direction) => {
      expect(aWager(kind).ledgerDirectionFor()).toBe(direction);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Credit],
      [Kind.Win, LedgerDirection.Debit],
      [Kind.Refund, LedgerDirection.Debit],
    ])('ledgerDirectionFor(): ROLLBACK of %s → %s (the inverse)', (referencedKind, direction) => {
      const reference = aProcessedWager(referencedKind);

      expect(aWager(Kind.Rollback).ledgerDirectionFor(reference)).toBe(direction);
    });

    it('ledgerDirectionFor() refuses LOSS, which has no ledger effect', () => {
      expect(() => aWager(Kind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    });

    it('ledgerDirectionFor() refuses a ROLLBACK without its reference', () => {
      expect(() => aWager(Kind.Rollback).ledgerDirectionFor()).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('rehydrate()', () => {
    it('rebuilds persisted state without re-validating creation rules', () => {
      const source = aProcessedWager(Kind.Bet);
      const rehydrated = WagerTransaction.rehydrate({
        ...source.toState(),
        kind: Kind.Refund,
        referenceExternalTransactionId: undefined,
      });

      expect(rehydrated.kind).toBe(Kind.Refund);
      expect(rehydrated.status).toBe(Status.Processed);
      expect(rehydrated.toState().payloadHash).toBe(source.payloadHash);
    });
  });
});
