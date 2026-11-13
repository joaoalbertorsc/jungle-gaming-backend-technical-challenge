import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../../src/shared/domain/errors';
import { Money } from '../../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('from()', () => {
    it.each([
      ['25.00', '25.00'],
      ['0.00', '0.00'],
      ['0', '0.00'],
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0.01', '0.01'],
      ['1000000.99', '1000000.99'],
    ])('accepts %p and serializes it with scale 2 as %p', (input, expected) => {
      expect(brl(input).amount).toBe(expected);
    });

    it('accepts the largest amount that fits NUMERIC(19,2)', () => {
      expect(brl('99999999999999999.99').amount).toBe('99999999999999999.99');
    });

    it.each([
      ['empty string', ''],
      ['whitespace', '  '],
      ['padded number', ' 10.00 '],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['scientific notation', '1e3'],
      ['scientific notation with decimals', '2.5E2'],
      ['negative value', '-1.00'],
      ['explicit plus sign', '+1.00'],
      ['more than 2 decimals', '10.005'],
      ['many decimals', '0.333333'],
      ['trailing dot', '10.'],
      ['leading dot', '.50'],
      ['leading zeros', '007.00'],
      ['thousands separator', '1,000.00'],
      ['decimal comma', '10,50'],
      ['hexadecimal', '0x10'],
      ['more integer digits than NUMERIC(19,2)', '100000000000000000.00'],
    ])('rejects %s (%p)', (_label, input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    });

    it('rejects a JSON number instead of a decimal string', () => {
      const props = { amount: 25 as unknown as string, currency: 'BRL' };

      expect(() => Money.from(props)).toThrow(InvalidMoneyError);
    });

    it.each(['brl', 'BR', 'BRLX', '', 'B1L'])('rejects the currency code %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('rounding', () => {
    it('never rounds: an amount with a third decimal is rejected, not rounded', () => {
      expect(() => brl('0.005')).toThrow(InvalidMoneyError);
      expect(() => brl('19.999')).toThrow(InvalidMoneyError);
    });

    it('adds without floating-point drift (0.10 + 0.20 = 0.30)', () => {
      expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    });

    it('keeps cents exact across many operations', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));

      expect(total.amount).toBe('10.00');
    });
  });

  describe('arithmetic', () => {
    it('adds two amounts', () => {
      expect(brl('975.00').add(brl('25.00')).amount).toBe('1000.00');
    });

    it('subtracts two amounts', () => {
      expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    });

    it('can produce a negative result internally', () => {
      expect(brl('20.00').subtract(brl('80.00')).amount).toBe('-60.00');
    });

    it('negates an amount', () => {
      expect(brl('25.50').negate().amount).toBe('-25.50');
      expect(brl('25.50').negate().negate().amount).toBe('25.50');
    });

    it('creates a zero amount for a currency', () => {
      const zero = Money.zero('USD');

      expect(zero.amount).toBe('0.00');
      expect(zero.currency).toBe('USD');
    });
  });

  describe('immutability', () => {
    it('returns new instances and leaves the operands untouched', () => {
      const a = brl('10.00');
      const b = brl('5.00');

      const sum = a.add(b);

      expect(sum).not.toBe(a);
      expect(a.amount).toBe('10.00');
      expect(b.amount).toBe('5.00');
    });

    it('cannot be mutated at runtime', () => {
      const money = brl('10.00');

      expect(() => {
        (money as unknown as { currency: string }).currency = 'USD';
      }).toThrow(TypeError);
    });
  });

  describe('comparisons', () => {
    it('reports sign', () => {
      expect(brl('0.00').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.00').isNegative()).toBe(false);
    });

    it('compares amounts of the same currency', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
      expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
    });

    it('treats equal amount and currency as equal regardless of input format', () => {
      expect(brl('25').equals(brl('25.00'))).toBe(true);
      expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    });

    it('never considers different currencies equal', () => {
      expect(brl('25.00').equals(Money.from({ amount: '25.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('currency conflict', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s across currencies raises CurrencyMismatchError', (_operation, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    });
  });

  describe('serialization', () => {
    it('serializes to the contract shape with a decimal string', () => {
      expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(JSON.stringify({ money: brl('25') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    });

    it('prints a readable string', () => {
      expect(brl('1000.5').toString()).toBe('1000.50 BRL');
    });

    it('round-trips through toJSON and from', () => {
      const original = brl('123.45');

      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    });
  });
});
