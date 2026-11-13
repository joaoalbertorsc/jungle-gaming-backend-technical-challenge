# ADR-0007: Pessimistic row lock per wallet

- Status: Accepted
- Date: 2026-11-12

## Context

The unit of concurrency is the `walletId` (§8). The system must avoid lost updates when several bets compete
for one balance, with several workers and three or more instances. No global lock is allowed (§5.6), and no
unguarded read → calculate → update (§5.7). The mandatory scenario: balance 100.00, two concurrent bets of
80.00, giving exactly one `PROCESSED`, one `REJECTED`, a final balance of 20.00 and one debit entry.

## Decision

- Every operation that can move a balance runs in one transaction. Its first statement locks the wallet row:
  `SELECT ... FOR UPDATE` (MikroORM `LockMode.PESSIMISTIC_WRITE`).
- Operations on the same wallet serialize. Different wallets proceed in parallel. There is no lock beyond the row.
- Each transaction locks exactly **one** wallet, so lock-ordering deadlocks cannot happen.
- **Bounded waits.** `lock_timeout` (around 2 s) caps the wait. A timeout is a **transient** error: HTTP 503
  with `Retry-After`, or an SQS retry. It is counted in `wallet_lock_conflicts_total`.
- **Version.** `version` increments only when the balance changes (§6.2). The defense in depth sits in the
  schema, not in a `WHERE version = ?` clause (revised in phase 3). The `wallets_version_tracks_balance`
  trigger only accepts `version = OLD.version + 1` together with a balance change, and
  `UNIQUE (wallet_id, wallet_version)` on the ledger rejects a second entry for the same version. A writer that
  bypassed the row lock with a stale read would therefore be rejected by PostgreSQL.
- **Last line of defense.** `CHECK (balance >= 0)` in the schema (ADR-0006).
- **Broker ordering.** FIFO `MessageGroupId = walletId` is an optimization only (§8); it guarantees nothing.

## Consequences

- Behaviour under hot wallets is deterministic: the second 80.00 bet waits for the first, then sees 20.00 and
  is rejected with `INSUFFICIENT_FUNDS`.
- Throughput per wallet is bounded by transaction latency, which is acceptable because each transaction is
  short. Different wallets scale with the connection pool.

## Alternatives considered

- **Optimistic locking with bounded retries.** Under contention (50 parallel identical bets) it turns into
  retry storms and non-deterministic retry exhaustion.
- **A single conditional atomic update** (`balance = balance - x WHERE balance >= x`). Strong, but it bypasses
  the aggregate, and computing the ledger's `balanceBefore`/`balanceAfter` becomes awkward.
- **SERIALIZABLE isolation.** It needs retry logic for every transaction, which is more complex for no benefit
  here.
