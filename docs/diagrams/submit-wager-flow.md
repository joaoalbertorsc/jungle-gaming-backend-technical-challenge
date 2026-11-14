# Submitting a wager

Source: `src/modules/wagering/application/submit-wager-transaction.ts`. The same use case serves HTTP and
SQS (§10).

```mermaid
sequenceDiagram
  autonumber
  participant P as Provider (HTTP / SQS)
  participant U as SubmitWagerTransaction
  participant DB as PostgreSQL

  P->>U: command + Idempotency-Key
  U->>U: WagerTransaction.create() validates kind, reference rules and money, computes payloadHash
  U->>DB: lookup by idempotency key / provider + external id (no lock, one snapshot)
  alt already stored
    U-->>P: replay (same outcome, balance observed then) or 409 conflict
  else new
    rect rgba(127, 127, 127, 0.12)
      note over U,DB: one SQL transaction, SET LOCAL lock_timeout
      U->>DB: SELECT wallet ... FOR UPDATE
      U->>DB: idempotency lookup again (authoritative, now serialized)
      U->>DB: resolve reference, is it already reversed?
      U->>U: WagerTransactionProcessor.process(): PROCESSED, REJECTED or PENDING_REFERENCE
      U->>DB: INSERT wager_transactions (+ retry schedule if parked)
      U->>DB: INSERT wallet_ledger_entries + UPDATE wallets (only when the balance moves)
      U->>DB: INSERT outbox_messages (Processed / Rejected / PendingReference, BalanceChanged)
      U->>DB: nudge transactions waiting on this one
      U->>DB: COMMIT (deferred check: balance = ledger entry of its version)
    end
    U-->>P: outcome (HTTP 201 / 422 / 202, SQS ack)
  end
```

## Concurrency outcomes

| Situation                                     | What happens                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Two bets on the same wallet                   | The second waits on the row lock, then sees the new balance (§8 scenario)                                  |
| 50 copies of the same bet                     | One processes; the others replay, from the fast path or after the lock                                     |
| Same key, different wallets, at the same time | Different rows are locked; the unique index rejects the loser, which retries once and replays or conflicts |
| Two reversals of one BET with different keys  | Serialized by the wallet lock; the second is `ALREADY_REVERSED` (the partial unique index backs it up)     |
| Lock held longer than `lock_timeout`          | `TransientInfrastructureError(LOCK_TIMEOUT)`: HTTP 503 / SQS retry, counted as a lock conflict             |
| Any failure before commit                     | Nothing is written: no transaction, entry, balance change or event                                         |
