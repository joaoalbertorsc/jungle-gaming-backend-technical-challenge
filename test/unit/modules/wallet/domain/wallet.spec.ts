import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../../../../src/modules/wallet/domain/wallet';
import {
  InsufficientFundsError,
  InvalidWalletOperationError,
} from '../../../../../src/modules/wallet/domain/wallet-errors';
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { CurrencyMismatchError } from '../../../../../src/shared/domain/errors';
import { Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const openedAt = new Date('2026-07-29T15:00:00.000Z');
const later = new Date('2026-07-29T15:05:00.000Z');

function openWallet(initialBalance = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openingCredit: { entryId: 'entry-opening', transactionId: 'tx-opening' },
    at: openedAt,
  });
}

let entrySequence = 0;
function movement(amount: string, at = later) {
  entrySequence += 1;
  return {
    entryId: `entry-${String(entrySequence)}`,
    transactionId: `tx-${String(entrySequence)}`,
    money: brl(amount),
    at,
  };
}

function replayLedger(currency: string, entries: readonly WalletLedgerEntry[]): Money {
  return entries.reduce((sum, entry) => sum.add(entry.signedAmount()), Money.zero(currency));
}

describe('Wallet', () => {
  describe('open()', () => {
    it('starts at version 1 with the initial balance', () => {
      const { wallet } = openWallet('1000.00');

      expect(wallet.balance.amount).toBe('1000.00');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(openedAt);
      expect(wallet.updatedAt).toEqual(openedAt);
    });

    it('records a positive initial balance as an OPENING credit entry', () => {
      const { wallet, openingEntry } = openWallet('1000.00');

      expect(openingEntry).toBeDefined();
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.transactionId).toBe('tx-opening');
      expect(openingEntry?.balanceBefore.amount).toBe('0.00');
      expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(openingEntry?.walletVersion).toBe(1);
    });

    it('creates no ledger entry when the initial balance is zero', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.zero('BRL'),
        at: openedAt,
      });

      expect(openingEntry).toBeUndefined();
      expect(wallet.version).toBe(1);
    });

    it('requires the opening transaction ids when the initial balance is positive', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId: 'player-1',
          initialBalance: brl('1.00'),
          at: openedAt,
        }),
      ).toThrow(InvalidWalletOperationError);
    });

    it('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId: 'player-1',
          initialBalance: brl('1.00').negate(),
          at: openedAt,
        }),
      ).toThrow(InvalidWalletOperationError);
    });
  });

  describe('debit()', () => {
    it('reduces the balance and returns the matching DEBIT entry', () => {
      const { wallet } = openWallet('1000.00');

      const entry = wallet.debit(movement('25.00'));

      expect(wallet.balance.amount).toBe('975.00');
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.amount).toBe('1000.00');
      expect(entry.balanceAfter.amount).toBe('975.00');
      expect(entry.walletId).toBe(wallet.id);
    });

    it('increments the version and touches updatedAt', () => {
      const { wallet } = openWallet();

      const entry = wallet.debit(movement('10.00'));

      expect(wallet.version).toBe(2);
      expect(entry.walletVersion).toBe(2);
      expect(wallet.updatedAt).toEqual(later);
    });

    it('allows debiting the whole balance down to zero', () => {
      const { wallet } = openWallet('80.00');

      wallet.debit(movement('80.00'));

      expect(wallet.balance.isZero()).toBe(true);
    });

    it('never goes negative: refuses a debit above the balance and keeps its state', () => {
      const { wallet } = openWallet('20.00');

      expect(() => wallet.debit(movement('80.00'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.amount).toBe('20.00');
      expect(wallet.version).toBe(1);
    });

    it('answers canDebit() consistently with debit()', () => {
      const { wallet } = openWallet('20.00');

      expect(wallet.canDebit(brl('20.00'))).toBe(true);
      expect(wallet.canDebit(brl('20.01'))).toBe(false);
    });
  });

  describe('credit()', () => {
    it('increases the balance, increments the version and returns a CREDIT entry', () => {
      const { wallet } = openWallet('975.00');

      const entry = wallet.credit(movement('50.00'));

      expect(wallet.balance.amount).toBe('1025.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    });
  });

  describe('guards', () => {
    it.each([
      ['debit', (wallet: Wallet) => wallet.debit(movement('0.00'))],
      ['credit', (wallet: Wallet) => wallet.credit(movement('0.00'))],
    ])('%s refuses a zero amount', (_operation, operation) => {
      const { wallet } = openWallet();

      expect(() => operation(wallet)).toThrow(InvalidWalletOperationError);
      expect(wallet.version).toBe(1);
    });

    it.each([
      ['canDebit', (wallet: Wallet, money: Money) => wallet.canDebit(money)],
      ['credit', (wallet: Wallet, money: Money) => wallet.credit({ ...movement('1.00'), money })],
      ['debit', (wallet: Wallet, money: Money) => wallet.debit({ ...movement('1.00'), money })],
    ])('%s refuses another currency', (_operation, operation) => {
      const { wallet } = openWallet();
      const usd = Money.from({ amount: '1.00', currency: 'USD' });

      expect(() => operation(wallet, usd)).toThrow(CurrencyMismatchError);
      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('balance and ledger consistency', () => {
    it('keeps balance == ledger replay and version == number of movements', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      const entries: WalletLedgerEntry[] = [openingEntry!];

      entries.push(wallet.debit(movement('30.00')));
      entries.push(wallet.credit(movement('12.34')));
      entries.push(wallet.debit(movement('82.34')));

      expect(wallet.balance.amount).toBe('0.00');
      expect(replayLedger('BRL', entries).equals(wallet.balance)).toBe(true);
      expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4]);
      expect(wallet.version).toBe(4);
      expect(entries.every((entry) => entry.isBalanced())).toBe(true);
    });
  });

  describe('rehydrate()', () => {
    it('rebuilds persisted state without re-validating it', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-9',
        playerId: 'player-9',
        currency: 'BRL',
        balance: brl('42.00'),
        version: 17,
        createdAt: openedAt,
        updatedAt: later,
      });

      expect(wallet.balance.amount).toBe('42.00');
      expect(wallet.version).toBe(17);
      expect(wallet.updatedAt).toEqual(later);
    });
  });
});
