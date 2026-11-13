# ADR-0005: Money as an exact, immutable value object

- Status: Accepted
- Date: 2026-11-12

## Context

`number`, `float` and `double` are forbidden for money (§5.1). Using `number` is an eliminatory failure.
Amounts travel as decimal strings with a fixed scale of 2. Operations across currencies must fail, invalid
inputs must be rejected, and the domain must not depend on ORM types (§6.1).

## Decision

- **Representation.** `Money` holds a `bigint` amount in minor units plus an ISO-4217 currency code. A fixed
  scale of 2 makes minor units exact, with no precision configuration and no rounding mode to get wrong.
- **Immutability.** Every operation (`add`, `subtract`, `negate`) returns a new instance.
- **Parsing.** `Money.from` (the input contract) accepts only plain decimal strings with up to 2 fractional
  digits. It rejects:
  - `NaN`, `Infinity`, scientific notation (`1e3`);
  - empty or whitespace strings;
  - more than 2 decimals;
  - negative values;
  - signs, thousand separators.
    Inputs such as `25` or `25.5` are normalized to `25.00` and `25.50`.
- **No silent rounding.** A value with more precision is **rejected**, never rounded. The rounding tests
  assert exactly that.
- **Serialization.** `toJSON()` / `toString()` always print 2 decimals (`{ "amount": "25.00", "currency": "BRL" }`).
- **Currency.** The code must be 3 uppercase letters. Operations across currencies throw a domain
  `CurrencyMismatchError`. The model is multi-currency, and BRL is the only currency used in practice.
- **Persistence.** The `money_amount` and `currency_code` domains (ADR-0004, ADR-0006). The database applies
  the same rules as `Money.from`, so it rejects a third decimal instead of rounding it.

## Consequences

- Precision cannot be lost by accident, because there is no floating point anywhere in the code path.
- Integration event payloads carry `MoneyProps` (decimal strings), never `Money` instances (§11).

## Alternatives considered

- **decimal.js / big.js.** Correct, but they add a dependency whose precision and rounding modes must be
  locked down. With a fixed scale of 2, `bigint` minor units are simpler.
