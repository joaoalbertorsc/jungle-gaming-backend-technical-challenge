import { describe, expect, it } from 'bun:test';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvalidLedgerEntryError } from '../../../../../src/modules/wallet/domain/wallet-errors';
import { CurrencyMismatchError } from '../../../../../src/shared/domain/errors';
import { Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00.000Z');

function validDebit(overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('1000.00'),
    balanceAfter: brl('975.00'),
    walletVersion: 2,
    createdAt: at,
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  describe('create()', () => {
    it('creates a balanced debit entry', () => {
      const entry = WalletLedgerEntry.create(validDebit());

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceAfter.amount).toBe('975.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('creates a balanced credit entry', () => {
      const entry = WalletLedgerEntry.create(
        validDebit({
          direction: LedgerDirection.Credit,
          balanceBefore: brl('975.00'),
          balanceAfter: brl('1000.00'),
        }),
      );

      expect(entry.isBalanced()).toBe(true);
    });

    it('rejects arithmetic that does not add up: before - money must equal after', () => {
      expect(() => WalletLedgerEntry.create(validDebit({ balanceAfter: brl('976.00') }))).toThrow(
        InvalidLedgerEntryError,
      );
    });

    it('rejects a credit recorded with debit arithmetic', () => {
      expect(() =>
        WalletLedgerEntry.create(validDebit({ direction: LedgerDirection.Credit })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it.each(['0.00'])('rejects a non-positive amount (%p)', (amount) => {
      expect(() =>
        WalletLedgerEntry.create(validDebit({ money: brl(amount), balanceAfter: brl('1000.00') })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejects a negative balance after the movement', () => {
      expect(() =>
        WalletLedgerEntry.create(
          validDebit({
            balanceBefore: brl('10.00'),
            balanceAfter: brl('10.00').subtract(brl('25.00')),
          }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it.each([0, -1, 1.5])('rejects the wallet version %p', (walletVersion) => {
      expect(() => WalletLedgerEntry.create(validDebit({ walletVersion }))).toThrow(
        InvalidLedgerEntryError,
      );
    });

    it('rejects mixed currencies', () => {
      const usd = Money.from({ amount: '25.00', currency: 'USD' });

      expect(() => WalletLedgerEntry.create(validDebit({ money: usd }))).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('immutability', () => {
    it('has no mutable fields at runtime', () => {
      const entry = WalletLedgerEntry.create(validDebit());

      expect(() => {
        (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('0.00');
      }).toThrow(TypeError);
    });

    it('exposes no state-changing methods', () => {
      const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
        (name) => name !== 'constructor',
      );

      expect(methods.sort()).toEqual(['isBalanced', 'signedAmount']);
    });
  });

  describe('signedAmount()', () => {
    it('is negative for debits and positive for credits', () => {
      const debit = WalletLedgerEntry.create(validDebit());
      const credit = WalletLedgerEntry.create(
        validDebit({
          direction: LedgerDirection.Credit,
          balanceBefore: brl('975.00'),
          balanceAfter: brl('1000.00'),
        }),
      );

      expect(debit.signedAmount().amount).toBe('-25.00');
      expect(credit.signedAmount().amount).toBe('25.00');
    });
  });

  describe('rehydrate()', () => {
    it('rebuilds persisted state without re-validating it', () => {
      const entry = WalletLedgerEntry.rehydrate(validDebit({ balanceAfter: brl('1.00') }));

      expect(entry.balanceAfter.amount).toBe('1.00');
      expect(entry.isBalanced()).toBe(false);
    });
  });
});
