# ADR-0006: Invariants enforced by the database schema

- Status: Accepted. The version-chain enforcement below is Proposed and will be evaluated in phase 2.
- Date: 2026-11-12

## Context

Uniqueness, immutability and non-negativity must be enforced **in the schema**, not only in application code
(§5.9). The design of constraints and indexes is evaluated in its own right.

## Decision

| Table                   | Guarantee                                                    | Mechanism                                                                                    |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `wallets`               | One wallet per player and currency                           | `UNIQUE (player_id, currency)`                                                               |
| `wallets`               | Balance never negative                                       | `CHECK (balance >= 0)`                                                                       |
| `wallets`               | Version starts at 1                                          | `CHECK (version >= 1)`                                                                       |
| `wager_transactions`    | Idempotency                                                  | `UNIQUE (idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)`               |
| `wager_transactions`    | Reversals carry a reference                                  | `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)` |
| `wager_transactions`    | A reference is reversed at most once in total (see below)    | Partial unique index on `(reference_transaction_id)` for processed `REFUND`/`ROLLBACK`       |
| `wager_transactions`    | Terminal states never change; business columns are immutable | Trigger rejecting such updates                                                               |
| `wallet_ledger_entries` | Append-only                                                  | Trigger rejecting `UPDATE`/`DELETE`; the app role also lacks those privileges                |
| `wallet_ledger_entries` | Entry arithmetic is balanced                                 | `CHECK (balance_after = balance_before ± amount)` by direction; `CHECK (amount > 0)`         |
| `wallet_ledger_entries` | At most one entry per wallet per transaction                 | `UNIQUE (transaction_id, wallet_id)`                                                         |
| `inbox_messages`        | Deduplication                                                | `PRIMARY KEY (consumer_name, message_id)`                                                    |
| `outbox_messages`       | Efficient relay claims                                       | Partial index on `next_attempt_at` where `published_at IS NULL`                              |

**Single reversal, stricter than §7 rule 4 (decided in phase 1).** The rule says a reference cannot be
reverted twice _by the same kind_. Read literally, a BET could then be refunded once **and** rolled back once,
and both credits would apply. That is a duplicated credit, which §3 forbids. So the index is on
`reference_transaction_id` alone: one effective reversal per reference. A ROLLBACK of a REFUND is still allowed,
because it reverses the REFUND (a different reference), not the BET.

**Two database roles.**

- `wagering_migrator` owns the schema and runs migrations.
- `wagering_app` is the runtime role and has DML only. It has no `UPDATE`/`DELETE` on the ledger, so even
  buggy code cannot rewrite history.

**Proposed: ledger version chain.**

- Each ledger entry stores the wallet version it produced, with `UNIQUE (wallet_id, wallet_version)`.
- A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `wallets` checks at commit that every balance change
  has a matching ledger entry (same version, `balance_after` equal to the new balance).
- The database would then guarantee "every balance change has a ledger entry, and vice versa" (§6.2), and the
  gap-free version would also make a stable ledger cursor (ADR-0013).
- It is adopted in phase 2 if its complexity stays reasonable.

## Consequences

- Races and bugs end in a constraint violation, never in corrupted money. The application maps those
  violations to stable error codes.
- Constraint behaviour is covered by integration tests against real PostgreSQL. Those tests are written before
  the migrations.

## Alternatives considered

- **Application-only checks.** Explicitly disallowed by §5.9.
