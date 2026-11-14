# Publishing outbox events

Source: `src/modules/messaging/application/outbox-relay.ts`, `src/infrastructure/database/mikro-orm-outbox-store.ts`
(ADR-0011).

```mermaid
sequenceDiagram
  autonumber
  participant R as OutboxRelay (any instance)
  participant DB as PostgreSQL (outbox_messages)
  participant E as wagering-events.fifo

  loop every poll (or immediately while there is work)
    R->>DB: UPDATE ... SET next_attempt_at = now + lease<br/>WHERE id IN (SELECT ... due ... FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *
    note over R,DB: autocommit: no lock is held while publishing, the lease keeps other relays away
    loop each claimed message (occurred_at order)
      R->>E: SendMessage(envelope, group = aggregateId, dedup = eventId)
      alt accepted
        R->>DB: UPDATE published_at = now WHERE id = ? AND published_at IS NULL
      else failed
        R->>DB: UPDATE attempts + 1, next_attempt_at = backoff, last_error
      end
    end
  end
```

## Crash and concurrency scenarios (§11)

| Scenario                                               | What happens                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Commit, then the process dies before publishing        | The row stays unpublished; after the lease expires another relay claims and publishes it               |
| Published, then the process dies before `published_at` | Republished after the lease; SQS FIFO dedup may drop it, and consumers deduplicate by `eventId` anyway |
| Two relays poll at the same time                       | `SKIP LOCKED` + lease: each row is claimed by one relay; nothing is lost                               |
| Broker unavailable                                     | `attempts` / `last_error` recorded, retried with exponential backoff (1 s → 5 min)                     |
| Transaction rolled back                                | Its outbox rows never existed: nothing to publish                                                      |
