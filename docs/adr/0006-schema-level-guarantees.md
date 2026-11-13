# ADR-0006: Invariants enforced by the database schema

- Status: Accepted. The ledger version chain was adopted in phase 2.
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

**Ledger version chain (adopted in phase 2).**

- Each ledger entry stores the wallet version it produced, with `UNIQUE (wallet_id, wallet_version)`.
- A `BEFORE INSERT` trigger on the ledger (`wallet_ledger_entries_chain`) requires every entry to continue
  the previous one: next version, and `balance_before` equal to the previous `balance_after`. The first entry
  must start from zero, at version 1 (OPENING credit) or 2 (first movement of a wallet opened at zero). The
  entry currency must match the wallet's (`wallet_ledger_entries_currency`).
- A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `wallets` (`wallets_balance_matches_ledger`) checks
  at commit that the balance equals the ledger entry of its version. The only exception is a zero balance at
  version 1.
- An immediate `BEFORE UPDATE` guard (`wallets_version_tracks_balance`) requires the version to grow by exactly
  1 with every balance change, and only then.
- Together these make "balance == ledger replay" (§6.2, §13) a **database invariant**. A wallet cannot hold a
  balance that its ledger does not explain, not even through hand-written SQL. The gap-free version is also
  the ledger cursor key (ADR-0013).

**Money domains.** `money_amount` (`NUMERIC` checked for >= 0, scale <= 2, < 10^17) and `currency_code`
(`CHAR(3)`, `^[A-Z]{3}$`) are reused by every monetary column. They reject what `Money.from` rejects, and they
do not round.

**Trigger-raised errors** use SQLSTATE `23514` (`check_violation`) with a named constraint, so they read and
map exactly like declarative CHECKs:

| Constraint name                         | Raised when                                                       |
| --------------------------------------- | ----------------------------------------------------------------- |
| `wallets_immutable_columns`             | `id`, `player_id`, `currency` or `created_at` changes             |
| `wallets_version_tracks_balance`        | Balance and version do not move together (+1)                     |
| `wallets_balance_matches_ledger`        | At commit, the balance differs from its version's ledger entry    |
| `wallets_no_delete`                     | `DELETE` / `TRUNCATE` on wallets                                  |
| `wager_transactions_terminal_immutable` | Any change to a `PROCESSED`, `REJECTED` or `FAILED` row           |
| `wager_transactions_immutable_columns`  | A business column (payload, money, ids, kind, key) changes        |
| `wager_transactions_transition`         | A status change outside the allowed transitions (§6.3)            |
| `wager_transactions_no_delete`          | `DELETE` / `TRUNCATE` on transactions                             |
| `wallet_ledger_entries_append_only`     | `UPDATE` / `DELETE` / `TRUNCATE` on the ledger, even by the owner |
| `wallet_ledger_entries_chain`           | An entry that does not continue the previous version and balance  |
| `wallet_ledger_entries_currency`        | An entry in another currency than its wallet                      |

All of them are covered by `test/integration/database/*.schema.spec.ts`. The data model diagram is in
[`docs/diagrams/data-model.md`](../diagrams/data-model.md).

## Consequences

- Races and bugs end in a constraint violation, never in corrupted money. The application maps those
  violations to stable error codes.
- Constraint behaviour is covered by integration tests against real PostgreSQL. Those tests are written before
  the migrations.

## Alternatives considered

- **Application-only checks.** Explicitly disallowed by §5.9.
