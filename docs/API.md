# HTTP API

Base URL (Docker Compose): `http://localhost:3000`. Money is always `{ "amount": "<decimal string>", "currency": "<ISO-4217>" }`.
Every error, on every endpoint, is RFC 9457 Problem Details (`application/problem+json`) with a stable `code`
(ADR-0009). Send `X-Correlation-Id` to trace a request; it is echoed in the response header and in errors.

Interactive version: Swagger UI at `/docs`, generated from the same validation schemas
(`/openapi.json`, `/openapi.yaml`).

## Wallets

### `POST /wallets`

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

`201`:

```json
{
  "id": "0192f291-…",
  "playerId": "0192f28f-…",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

A positive initial balance creates an internal `OPENING` transaction and its `CREDIT` ledger entry in the same
SQL transaction. Errors: `409 WALLET_ALREADY_EXISTS`, `400 VALIDATION_FAILED`, `400 INVALID_MONEY`.

### `GET /wallets/:walletId`

`200` with the same shape. Errors: `404 WALLET_NOT_FOUND`, `400 VALIDATION_FAILED` (not a UUID).

### `GET /wallets/:walletId/ledger?cursor=…&limit=50`

`200`:

```json
{
  "entries": [
    {
      "id": "…",
      "transactionId": "…",
      "direction": "CREDIT",
      "money": { "amount": "1000.00", "currency": "BRL" },
      "balanceBefore": { "amount": "0.00", "currency": "BRL" },
      "balanceAfter": { "amount": "1000.00", "currency": "BRL" },
      "walletVersion": 1,
      "createdAt": "2026-07-29T15:00:00.000Z"
    }
  ],
  "nextCursor": "eyJ2IjoxLCJhZnRlciI6MX0"
}
```

Entries are in wallet-version order. `limit` ranges from 1 to 200 (default 50). `nextCursor` is opaque and
stable, and it is `null` on the last page. Errors: `400 INVALID_CURSOR`, `404 WALLET_NOT_FOUND`.

### `POST /wallets/:walletId/reconciliation`

`200`:

```json
{
  "walletId": "…",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42
}
```

A divergence is logged and counted, and the response says `consistent: false`. It is never corrected.

## Wagering

### `POST /wagering/transactions`

Header `Idempotency-Key` is **required** (recommended value: `{providerId}:{externalTransactionId}`).

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

`kind` is one of `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. `REFUND` and `ROLLBACK` also require
`referenceExternalTransactionId`, which `WIN` and `LOSS` may carry too.

Response body (all outcomes):

```json
{
  "transactionId": "…",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

| Status | Meaning                                                                                                   | Provider action        |
| ------ | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| `201`  | New transaction, `PROCESSED`                                                                              | Done                   |
| `200`  | Identical replay of a processed transaction (`idempotentReplay: true`)                                    | Done                   |
| `202`  | `PENDING_REFERENCE`: the referenced transaction has not arrived yet                                       | Nothing; it is retried |
| `422`  | `REJECTED` with `failureCode` (body as above), or `WALLET_NOT_FOUND` (Problem Details)                    | Do not resend as is    |
| `400`  | `VALIDATION_FAILED`, `INVALID_MONEY`, `INVALID_WAGER_TRANSACTION` (+`reason`), `IDEMPOTENCY_KEY_REQUIRED` | Fix the request        |
| `409`  | `IDEMPOTENCY_CONFLICT` (+`reason`: `PAYLOAD_MISMATCH` or `EXTERNAL_ID_REUSED`)                            | Use a new key/id       |
| `503`  | `TEMPORARILY_UNAVAILABLE` (+`Retry-After`)                                                                | Retry the same request |

A replay keeps the status of the original outcome (`422`, `202`), except that `PROCESSED` becomes `200`.

### `GET /wagering/transactions/:transactionId`

### `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

`200` with the full transaction (ids, kind, money, status, failure code, references, resulting balance,
timestamps). Errors: `404 TRANSACTION_NOT_FOUND`.

## Health (unauthenticated)

| Endpoint            | `200`                                                             | `503`                                                               |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /health/live`  | Process alive                                                     | never                                                               |
| `GET /health/ready` | `{ "status": "ok", "checks": { "database": "up", "sqs": "up" } }` | Same shape with `"unavailable"` and the failing dependency `"down"` |

## Problem Details example

```json
{
  "type": "urn:wagering:problem:IDEMPOTENCY_CONFLICT",
  "title": "Idempotency conflict",
  "status": 409,
  "detail": "the Idempotency-Key was already used with a different payload",
  "code": "IDEMPOTENCY_CONFLICT",
  "correlationId": "0192f2a0-…",
  "instance": "/wagering/transactions",
  "reason": "PAYLOAD_MISMATCH"
}
```
