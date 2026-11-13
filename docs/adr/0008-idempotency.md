# ADR-0008: Persistent idempotency and replay

- Status: Accepted
- Date: 2026-11-12

## Context

Delivery is at-least-once (§3). The `Idempotency-Key` header is mandatory and is the source of truth (§9).
An identical request must return the same response with `idempotentReplay: true`; the same key with a
different payload is a **conflict**, not a replay. A replay returns the original result, including the
balance observed at that moment (§7 rule 7). An in-memory cache must never be the guarantee (§5.2).

## Decision

- **Storage.** The key is stored on `wager_transactions` and protected by `UNIQUE (idempotency_key)` plus
  `UNIQUE (provider_id, external_transaction_id)`. SQS messages carry `data.idempotencyKey`.
- **`payloadHash` (algorithm v1).** SHA-256, hex-encoded, over the **canonical JSON** of the business fields:
  `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
  `money.amount` and `money.currency`, plus `referenceExternalTransactionId` when present.
  - Canonical JSON means object keys sorted recursively, no insignificant whitespace, and amounts normalized
    to 2 decimals.
  - The header and transport metadata (`messageId`, `occurredAt`, HTTP headers) are excluded.
- **Flow.** Inside the wallet lock (ADR-0007), the transaction is looked up by key:
  - not found: process normally;
  - found, same hash: return the stored outcome with `idempotentReplay: true`;
  - found, different hash: `IdempotencyConflictError` (HTTP 409), never a replay.
- **Races across wallets.** If the same key arrives with a different `walletId`, the two requests lock
  different rows. The unique constraint makes one fail; it re-reads and classifies as above.
- **Stored outcome.** Status, `failureCode` and the resulting balance snapshot are persisted with the
  transaction, so a replay returns exactly what the first call observed.
- **Transport deduplication.** SQS duplicates are also caught by the persistent inbox (ADR-0010).

## Consequences

- Fifty parallel copies of the same bet produce one debit (§13 concurrency scenario 1). The other 49 are
  replays, or a conflict when the payloads differ.
- The hash algorithm is versioned (v1). Changing it requires a migration strategy.

## Alternatives considered

- **Redis or an in-memory idempotency store.** Forbidden as the guarantee.
- **Hashing the raw request body.** Field order and whitespace would change the hash, so identical requests
  could look different.
