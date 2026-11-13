# ADR-0010: SQS consumer with persistent inbox

- Status: Accepted
- Date: 2026-11-12

## Context

The consumer must:

- reuse the HTTP use case;
- deduplicate through a persistent inbox keyed by `(consumerName, messageId)`;
- ack only after commit;
- treat business, transient and permanent errors differently;
- respect an attempt limit before the DLQ;
- handle `SIGTERM`;
- survive redelivery without duplicating effects (§10).

## Decision

**Client.** A custom long-polling loop over `@aws-sdk/client-sqs` v3 (`WaitTimeSeconds = 20`). There is no
`sqs-consumer` library, so ack, visibility and shutdown stay explicit.

**Per message:**

1. Parse and validate the envelope and `data` with the shared Zod schema.
2. In **one transaction**:
   - insert the inbox row `(consumer_name, message_id, payload_hash)`;
   - run the same `SubmitWagerTransaction` use case the HTTP API uses;
   - mark the inbox row processed;
   - commit.
3. Only then `DeleteMessage` (ack).

**Duplicates.**

- An inbox conflict with the same hash is a duplicate: ack without running the use case.
- The same `messageId` with a different hash is an anomaly. It is treated as a permanent error (DLQ) and logged.

**Error classification:**

| Class            | Examples                                                           | Action                                                                                        |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Business outcome | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`                       | Commit, then ack                                                                              |
| Transient        | Database unavailable, lock timeout                                 | No ack. `ChangeMessageVisibility` with exponential backoff based on `ApproximateReceiveCount` |
| Permanent        | Malformed JSON, schema violation, `kind = OPENING`, unknown `type` | Send to the DLQ with a reason attribute, then ack                                             |

**Attempt limit.** The redrive policy (`maxReceiveCount = 5`) moves messages whose transient retries are
exhausted to `wager-transactions-dlq.fifo`.

**Ordering.** Producers should use `MessageGroupId = walletId`. That is an ordering optimization only.

**Graceful shutdown.** On `SIGTERM`: stop polling, let in-flight messages finish within a drain timeout, then
`ChangeMessageVisibility(0)` on anything left so another instance takes it immediately.

## Consequences

- If the process dies after commit and before ack, the redelivered message hits the inbox and is acked, with
  no second effect (§13 concurrency scenario 5).
- Every DLQ message carries a reason, which makes it diagnosable.

## Alternatives considered

- **Relying on FIFO deduplication.** Its window is 5 minutes and it is not a consistency guarantee (§5.3).
- **The `sqs-consumer` library.** It hides the ack and visibility semantics this design needs to control.
