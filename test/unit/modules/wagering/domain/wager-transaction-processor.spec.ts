import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../../../src/modules/wagering/domain/failure-code';
import {
  type ProcessWagerOutcome,
  WagerTransactionProcessor,
} from '../../../../../src/modules/wagering/domain/wager-transaction-processor';
import {
  type WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { InvalidTransactionStateError } from '../../../../../src/modules/wagering/domain/wagering-errors';
import type { Wallet } from '../../../../../src/modules/wallet/domain/wallet';
import { LedgerDirection } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { Money } from '../../../../../src/shared/domain/money';
import { aProcessedWager, aWager, aWallet, brl, T1 } from '../../../../support/builders/wagering';

const processor = new WagerTransactionProcessor();

function process(
  transaction: WagerTransaction,
  wallet: Wallet,
  options: { reference?: WagerTransaction; referenceAlreadyReversed?: boolean } = {},
): ProcessWagerOutcome {
  return processor.process({
    transaction,
    wallet,
    reference: options.reference,
    referenceAlreadyReversed: options.referenceAlreadyReversed ?? false,
    ledgerEntryId: 'entry-new',
    at: T1,
  });
}

/** A rejection must leave the wallet untouched and produce no ledger entry (§7 rule 6). */
function expectRejected(
  outcome: ProcessWagerOutcome,
  transaction: WagerTransaction,
  wallet: Wallet,
  balanceBefore: string,
  code: FailureCode,
) {
  expect(outcome).toEqual({ type: 'rejected', failureCode: code });
  expect(transaction.status).toBe(Status.Rejected);
  expect(transaction.failureCode).toBe(code);
  expect(transaction.resultingBalance?.amount).toBe(balanceBefore);
  expect(wallet.balance.amount).toBe(balanceBefore);
  expect(wallet.version).toBe(1);
}

function processedEntry(outcome: ProcessWagerOutcome) {
  if (outcome.type !== 'processed') throw new Error(`expected processed, got ${outcome.type}`);
  return outcome.ledgerEntry;
}

const theBet = (overrides: Parameters<typeof aProcessedWager>[1] = {}) =>
  aProcessedWager(Kind.Bet, { externalTransactionId: 'ext-referenced', ...overrides });

describe('WagerTransactionProcessor', () => {
  describe('BET', () => {
    it('debits the wallet and records a single DEBIT entry', () => {
      const wallet = aWallet('1000.00');
      const bet = aWager(Kind.Bet, { money: brl('25.00') });

      const entry = processedEntry(process(bet, wallet));

      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(entry?.money.amount).toBe('25.00');
      expect(wallet.balance.amount).toBe('975.00');
      expect(bet.status).toBe(Status.Processed);
      expect(bet.resultingBalance?.amount).toBe('975.00');
      expect(bet.processedAt).toEqual(T1);
    });

    it('is rejected with INSUFFICIENT_FUNDS when the balance is too low', () => {
      const wallet = aWallet('20.00');
      const bet = aWager(Kind.Bet, { money: brl('80.00') });

      expectRejected(process(bet, wallet), bet, wallet, '20.00', FailureCode.InsufficientFunds);
    });

    it('§8 scenario: 100.00 and two 80.00 bets → one PROCESSED, one REJECTED, 20.00, one debit', () => {
      const wallet = aWallet('100.00');
      const first = aWager(Kind.Bet, { money: brl('80.00') });
      const second = aWager(Kind.Bet, { money: brl('80.00') });

      const outcomes = [process(first, wallet), process(second, wallet)];

      expect(outcomes.map((o) => o.type)).toEqual(['processed', 'rejected']);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.amount).toBe('20.00');
      expect(outcomes.filter((o) => o.type === 'processed' && o.ledgerEntry)).toHaveLength(1);
    });
  });

  describe('WIN', () => {
    it('credits the wallet', () => {
      const wallet = aWallet('975.00');
      const win = aWager(Kind.Win, { money: brl('50.00') });

      const entry = processedEntry(process(win, wallet));

      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.amount).toBe('1025.00');
    });

    it('may reference the round BET and records the resolved reference', () => {
      const wallet = aWallet('975.00');
      const bet = theBet();
      const win = aWager(Kind.Win, { referenceExternalTransactionId: 'ext-referenced' });

      process(win, wallet, { reference: bet });

      expect(win.status).toBe(Status.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
    });

    it('rejects a reference that is not a BET', () => {
      const wallet = aWallet('100.00');
      const otherWin = aProcessedWager(Kind.Win, { externalTransactionId: 'ext-referenced' });
      const win = aWager(Kind.Win, { referenceExternalTransactionId: 'ext-referenced' });

      expectRejected(
        process(win, wallet, { reference: otherWin }),
        win,
        wallet,
        '100.00',
        FailureCode.InvalidReferenceKind,
      );
    });
  });

  describe('LOSS', () => {
    it('records the result without moving money or creating a ledger entry', () => {
      const wallet = aWallet('975.00');
      const loss = aWager(Kind.Loss, { money: brl('25.00') });

      const outcome = process(loss, wallet);

      expect(outcome).toEqual({ type: 'processed', ledgerEntry: undefined });
      expect(loss.status).toBe(Status.Processed);
      expect(wallet.balance.amount).toBe('975.00');
      expect(wallet.version).toBe(1);
      expect(loss.resultingBalance?.amount).toBe('975.00');
    });

    it('may reference the round BET', () => {
      const bet = theBet();
      const loss = aWager(Kind.Loss, { referenceExternalTransactionId: 'ext-referenced' });

      process(loss, aWallet('975.00'), { reference: bet });

      expect(loss.referenceTransactionId).toBe(bet.id);
    });
  });

  describe('REFUND', () => {
    it('credits back a processed BET exactly', () => {
      const wallet = aWallet('975.00');
      const bet = theBet({ money: brl('25.00') });
      const refund = aWager(Kind.Refund, { money: brl('25.00') });

      const entry = processedEntry(process(refund, wallet, { reference: bet }));

      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.amount).toBe('1000.00');
      expect(refund.referenceTransactionId).toBe(bet.id);
    });

    it('only references a BET', () => {
      const wallet = aWallet('100.00');
      const win = aProcessedWager(Kind.Win, { externalTransactionId: 'ext-referenced' });
      const refund = aWager(Kind.Refund);

      expectRejected(
        process(refund, wallet, { reference: win }),
        refund,
        wallet,
        '100.00',
        FailureCode.InvalidReferenceKind,
      );
    });

    it('reverts a BET only once', () => {
      const wallet = aWallet('100.00');
      const refund = aWager(Kind.Refund);

      expectRejected(
        process(refund, wallet, { reference: theBet(), referenceAlreadyReversed: true }),
        refund,
        wallet,
        '100.00',
        FailureCode.AlreadyReversed,
      );
    });

    it('must match the BET amount (no partial refunds)', () => {
      const wallet = aWallet('100.00');
      const refund = aWager(Kind.Refund, { money: brl('10.00') });

      expectRejected(
        process(refund, wallet, { reference: theBet({ money: brl('25.00') }) }),
        refund,
        wallet,
        '100.00',
        FailureCode.AmountMismatch,
      );
    });

    it('is rejected when the BET was itself rejected', () => {
      const wallet = aWallet('100.00');
      const rejectedBet = aWager(Kind.Bet, { externalTransactionId: 'ext-referenced' });
      rejectedBet.reject({
        failureCode: FailureCode.InsufficientFunds,
        resultingBalance: brl('0.00'),
        at: T1,
      });
      const refund = aWager(Kind.Refund);

      expectRejected(
        process(refund, wallet, { reference: rejectedBet }),
        refund,
        wallet,
        '100.00',
        FailureCode.ReferenceNotProcessed,
      );
    });

    it.each([
      ['player', { playerId: 'player-2' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['round', { roundId: 'round-other' }],
      ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ])('requires the same %s as the BET', (_field, betOverride) => {
      const wallet = aWallet('100.00');
      const refund = aWager(Kind.Refund);

      expectRejected(
        process(refund, wallet, { reference: theBet(betOverride) }),
        refund,
        wallet,
        '100.00',
        FailureCode.ReferenceMismatch,
      );
    });
  });

  describe('ROLLBACK', () => {
    it.each([
      [Kind.Bet, LedgerDirection.Credit, '125.00'],
      [Kind.Win, LedgerDirection.Debit, '75.00'],
      [Kind.Refund, LedgerDirection.Debit, '75.00'],
    ])('of a %s applies the inverse movement (%s)', (referencedKind, direction, balanceAfter) => {
      const wallet = aWallet('100.00');
      const reference = aProcessedWager(referencedKind, {
        externalTransactionId: 'ext-referenced',
        referenceExternalTransactionId: referencedKind === Kind.Bet ? undefined : 'ext-older',
      });
      const rollback = aWager(Kind.Rollback);

      const entry = processedEntry(process(rollback, wallet, { reference }));

      expect(entry?.direction).toBe(direction);
      expect(wallet.balance.amount).toBe(balanceAfter);
      expect(rollback.referenceTransactionId).toBe(reference.id);
    });

    it('rejects a reversal that would go negative with REVERSAL_WOULD_OVERDRAW, not INSUFFICIENT_FUNDS', () => {
      const wallet = aWallet('10.00');
      const win = aProcessedWager(Kind.Win, { externalTransactionId: 'ext-referenced' });
      const rollback = aWager(Kind.Rollback);

      expectRejected(
        process(rollback, wallet, { reference: win }),
        rollback,
        wallet,
        '10.00',
        FailureCode.ReversalWouldOverdraw,
      );
    });

    it('cannot reverse a LOSS', () => {
      const wallet = aWallet('100.00');
      const loss = aProcessedWager(Kind.Loss, { externalTransactionId: 'ext-referenced' });
      const rollback = aWager(Kind.Rollback);

      expectRejected(
        process(rollback, wallet, { reference: loss }),
        rollback,
        wallet,
        '100.00',
        FailureCode.InvalidReferenceKind,
      );
    });

    it('cannot reverse a BET that was already refunded (no double credit)', () => {
      const wallet = aWallet('100.00');
      const rollback = aWager(Kind.Rollback);

      expectRejected(
        process(rollback, wallet, { reference: theBet(), referenceAlreadyReversed: true }),
        rollback,
        wallet,
        '100.00',
        FailureCode.AlreadyReversed,
      );
    });
  });

  describe('references delivered out of order (§7 rule 8)', () => {
    it('parks the transaction as PENDING_REFERENCE when the reference has not arrived', () => {
      const wallet = aWallet('100.00');
      const refund = aWager(Kind.Refund);

      const outcome = process(refund, wallet);

      expect(outcome).toEqual({ type: 'pending-reference' });
      expect(refund.status).toBe(Status.PendingReference);
      expect(refund.resultingBalance?.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('keeps waiting when a retry still finds no reference', () => {
      const refund = aWager(Kind.Refund);
      process(refund, aWallet('100.00'));

      expect(process(refund, aWallet('100.00'))).toEqual({ type: 'pending-reference' });
      expect(refund.status).toBe(Status.PendingReference);
    });

    it('processes the parked transaction once the reference exists', () => {
      const wallet = aWallet('975.00');
      const refund = aWager(Kind.Refund);
      process(refund, wallet);

      process(refund, wallet, { reference: theBet() });

      expect(refund.status).toBe(Status.Processed);
      expect(wallet.balance.amount).toBe('1000.00');
    });

    it('waits while the reference exists but is itself still undecided', () => {
      const pendingBet = aWager(Kind.Bet, { externalTransactionId: 'ext-referenced' });
      const refund = aWager(Kind.Refund);

      expect(process(refund, aWallet('100.00'), { reference: pendingBet })).toEqual({
        type: 'pending-reference',
      });
    });
  });

  describe('wallet checks', () => {
    it('rejects a wallet that belongs to another player', () => {
      const wallet = aWallet('100.00', { playerId: 'player-2' });
      const bet = aWager(Kind.Bet);

      expectRejected(process(bet, wallet), bet, wallet, '100.00', FailureCode.WalletPlayerMismatch);
    });

    it('rejects an operation in another currency', () => {
      const wallet = aWallet('100.00', { currency: 'USD' });
      const bet = aWager(Kind.Bet);

      expectRejected(process(bet, wallet), bet, wallet, '100.00', FailureCode.CurrencyMismatch);
    });

    it('refuses to process a transaction against a different wallet (programming error)', () => {
      const bet = aWager(Kind.Bet, { walletId: 'wallet-2' });

      expect(() => process(bet, aWallet('100.00'))).toThrow(InvalidTransactionStateError);
    });

    it('refuses to process a transaction that is already terminal', () => {
      const wallet = aWallet('100.00');
      const bet = aWager(Kind.Bet);
      process(bet, wallet);

      expect(() => process(bet, wallet)).toThrow(InvalidTransactionStateError);
      expect(wallet.balance.amount).toBe('75.00');
    });
  });
});
