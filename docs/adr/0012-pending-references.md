# ADR-0012: Out-of-order references (PENDING_REFERENCE)

- Status: Accepted
- Date: 2026-11-12

## Context

A `REFUND` or `ROLLBACK` can arrive before the transaction it references. Such a transaction is persisted as
`PENDING_REFERENCE` and reprocessed by a scheduled worker with exponential backoff. The attempt limit or TTL
is the candidate's choice. Once it is exhausted, the transaction becomes `REJECTED` with a failure code
identifying the missing reference, and an event is published (§7.1).

## Decision

**On arrival.** If the reference `(providerId, referenceExternalTransactionId)` is not found:

- persist the transaction as `PENDING_REFERENCE` and emit `WagerTransactionPendingReference`;
- HTTP answers 202, and SQS acks.

**Retry worker (`retry-worker` role):**

- Claims due rows with `FOR UPDATE SKIP LOCKED` and a lease, the same way the outbox relay does.
- Re-resolves the reference inside the wallet lock (ADR-0007).

**Backoff.** Starts at 1 s and doubles each attempt, capped at 5 min. The limit is **10 attempts, about 13
minutes in total**.

**Exhaustion.** `REJECTED` with `REFERENCE_NOT_FOUND`, plus `WagerTransactionRejected`.

**Nudge.** When a transaction is processed, pending rows waiting on its `(providerId, externalTransactionId)`
get `next_attempt_at = now()` in the same transaction. They are retried on the next tick instead of after the
current backoff.

**Configuration.** Every value is configurable through the environment.

**Rationale for the limit.** Game rounds are short. A reference that has not appeared after ~13 minutes is
almost certainly lost, and the provider can resubmit.

## Consequences

- Out-of-order delivery converges without busy loops (§13 concurrency scenario 7).
- Pending rows are visible and auditable while they wait.

## Alternatives considered

- **Rejecting immediately.** Violates §7 rule 8.
- **Re-enqueueing on SQS with a delay.** Moves state out of the database and loses auditability.
