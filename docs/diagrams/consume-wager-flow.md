# Consuming a wager from SQS

Why: SQS delivers at least once and a consumer can die at any step. A message must change the wallet once,
and failures must split into done (ack), try again later (retry) and needs a human (DLQ).

Source: `src/modules/wagering/interface/sqs/wager-transaction-consumer.ts` (ADR-0010).

```mermaid
sequenceDiagram
  autonumber
  participant Q as wager-transactions.fifo
  participant C as WagerTransactionConsumer
  participant U as SubmitWagerTransaction
  participant DB as PostgreSQL
  participant D as wager-transactions-dlq.fifo

  C->>Q: ReceiveMessage (long poll, up to 10)
  Q-->>C: messages (per group in order)
  C->>C: parseWagerMessage(): JSON + schema, fingerprint (SHA-256 of canonical JSON)
  alt malformed or invalid
    C->>D: SendMessage(body, dlq-reason)
    C->>Q: DeleteMessage
  else valid
    C->>DB: inbox lookup (consumer, messageId)
    alt already processed
      C->>Q: DeleteMessage (duplicate, counted)
    else new
      rect rgba(127, 127, 127, 0.12)
        note over U,DB: one SQL transaction
        U->>DB: INSERT inbox_messages
        U->>DB: wallet lock, idempotency, rules, transaction, ledger, outbox
        U->>DB: COMMIT
      end
      alt outcome (PROCESSED / REJECTED / PENDING_REFERENCE) or unknown wallet
        C->>Q: DeleteMessage (ack only after commit)
      else transient (lock timeout, database down)
        C->>Q: ChangeMessageVisibility(backoff(receiveCount))
        note over Q: after maxReceiveCount the redrive policy moves it to the DLQ
      else permanent (idempotency conflict, invalid money)
        C->>D: SendMessage(body, dlq-reason)
        C->>Q: DeleteMessage
      end
    end
  end
```

## Failure scenarios

| Scenario                                   | Outcome                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Same message delivered twice               | The inbox row exists: acked, counted as a duplicate, no second effect                 |
| Crash after commit, before `DeleteMessage` | Visibility expires, the message returns, the inbox recognises it, acked               |
| Two consumers get the same message         | One commits; the other fails on `inbox_messages_pkey`, treats it as a duplicate, acks |
| Same `messageId`, different content        | Dead-lettered as `MESSAGE_ID_REUSED`                                                  |
| PostgreSQL down / wallet lock held         | Retried with exponential visibility backoff; dead-lettered by the redrive policy      |
| `SIGTERM`                                  | Polling stops, in-flight messages finish, received-but-unstarted ones are released    |
