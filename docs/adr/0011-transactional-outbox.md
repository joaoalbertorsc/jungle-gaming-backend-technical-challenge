# ADR-0011: Transactional outbox and integration events

- Status: Accepted
- Date: 2026-11-12

## Context

No event may be published before the financial transaction commits (§5.4). The financial change and its
events are atomic. A relay must work with several concurrent publishers without losing events or duplicating
them indefinitely, including when the process dies after commit and before publishing (§11).

## Decision

**Writing events.** Use cases append `OutboxMessage` rows **in the same transaction** as the financial change.

**Events:**

- `WagerTransactionProcessed`: every applied transaction, including `LOSS`;
- `WagerTransactionRejected`;
- `WalletBalanceChanged`: only when the balance changes;
- `WagerTransactionPendingReference`.

**Envelope.** An abstract `IntegrationEvent<T>` class. Each event is a subclass that fixes `eventType` and
`version` in the type. `data` carries `MoneyProps` decimal strings, never `Money` instances.

**Relay.** Each `outbox-relay` instance loops:

1. **Claim** a batch in a short transaction:
   `UPDATE ... SET next_attempt_at = now() + lease WHERE id IN (SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT n) RETURNING ...`.
   No lock is held during network calls. If the instance dies, the lease expires and another instance takes over.
2. **Publish** to `wagering-events.fifo` with `MessageGroupId = aggregateId` and `MessageDeduplicationId = eventId`.
3. On success, set `published_at`. On failure, `scheduleRetry` (attempts + 1, exponential backoff).

**Delivery semantics.** At-least-once. A crash after publish and before `published_at` causes a republish,
which is safe because consumers deduplicate by `eventId`. The project includes a reference event consumer and
a test proving that a duplicate publish has no effect (§11 step 5).

**Outbox lag.** `now() - min(occurred_at)` over unpublished rows, exported as a metric.

## Implementation notes (phase 6)

- **Claim.** One autocommit statement:
  `UPDATE outbox_messages SET next_attempt_at = now + lease FROM (SELECT id ... WHERE published_at IS NULL
AND next_attempt_at <= now ORDER BY next_attempt_at, occurred_at LIMIT n FOR UPDATE SKIP LOCKED)`.
  The lease (default 30 s) protects the claim; no row lock outlives the statement.
- **Mark published** only after `SendMessage` succeeded, conditioned on `published_at IS NULL`.
- **Failure.** `attempts + 1`, `last_error`, and `next_attempt_at` from exponential backoff (1 s doubling up
  to 5 min).
- **Config:** `OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_RETRY_BASE_MS`,
  `OUTBOX_RETRY_MAX_MS`.
- **Process.** `APP_ROLES=outbox-relay`. Any number of replicas can run.
- **Reference consumer.** `test/support/relay.ts` `applyOnce()` records the `eventId` in an inbox and proves
  that a duplicate publication is applied once.
- **Flow diagram:** [`docs/diagrams/outbox-relay-flow.md`](../diagrams/outbox-relay-flow.md).

## Consequences

- Events are never lost once committed, and never published for rolled-back work.
- Ordering is per aggregate, best effort. Consumers must tolerate duplicates.

## Alternatives considered

- **Publishing in the use case after commit.** A crash between commit and publish loses the event.
- **A row lock held while publishing.** Simpler, but it ties a database lock to network latency.
- **Logical replication / CDC (Debezium).** Too heavy for this scope.
