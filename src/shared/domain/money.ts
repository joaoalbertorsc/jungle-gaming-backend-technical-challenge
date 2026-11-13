import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Contract shape for money in HTTP bodies, SQS messages and event payloads. */
export interface MoneyProps {
  /** Non-negative decimal string, e.g. "25.00". */
  readonly amount: string;
  /** ISO-4217 code, e.g. "BRL". */
  readonly currency: string;
}

const MINOR_UNITS_PER_UNIT = 100n;
/** Up to 17 integer digits (NUMERIC(19,2)), optional 1–2 decimals, no sign, no leading zeros. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Exact, immutable monetary value (ADR-0005).
 *
 * The amount is held as a `bigint` count of minor units (scale fixed at 2), so no floating-point
 * value ever takes part in a calculation. Input with more precision is rejected, never rounded.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses the input contract: a non-negative decimal string with at most 2 decimals. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props as { amount: unknown; currency: unknown };
    const validCurrency = Money.assertCurrency(currency);

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    const match = AMOUNT_PATTERN.exec(amount);
    if (match === null) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with at most 2 decimals and 17 integer digits',
      );
    }

    const [, integerPart = '0', fraction = ''] = match;
    const minorUnits = BigInt(integerPart) * MINOR_UNITS_PER_UNIT + BigInt(fraction.padEnd(2, '0'));
    return new Money(minorUnits, validCurrency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  /** Decimal string with exactly 2 decimals; negative results carry a leading "-". */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const units = (absolute / MINOR_UNITS_PER_UNIT).toString();
    const cents = (absolute % MINOR_UNITS_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Equal amount and currency. Different currencies are simply not equal (no error). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter uppercase ISO-4217 code');
    }
    return currency;
  }
}
