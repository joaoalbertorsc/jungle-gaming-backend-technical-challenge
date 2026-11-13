/**
 * Base class for errors raised by domain rules. Each subclass carries a stable, machine-readable
 * `code`; adapters (HTTP filter, SQS classifier) map codes to transport behaviour (ADR-0009).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An amount or currency that violates the Money contract (ADR-0005). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

/** An operation combined amounts of different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
