# ADR-0009: Business outcomes, failure codes and the HTTP error contract

- Status: Accepted. The failure-code taxonomy is a draft, finalized in phase 1.
- Date: 2026-11-12

## Context

Every rejection needs a stable, machine-readable `failureCode` that tells the provider whether to resend,
fix the payload or give up (§7.2). The API must distinguish, consistently across endpoints, five situations:
invalid payload, idempotency conflict, business rejection, accepted-but-pending, and transient
infrastructure failure (§9).

## Decision

**Business rejections are outcomes, not exceptions.** A rejected wager is persisted as `REJECTED` with its
`failureCode`. It is auditable and replayable.

**Failure codes (draft):**

| Code                      | Meaning                                                                   | Provider action                         |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| `INSUFFICIENT_FUNDS`      | BET exceeds the balance                                                   | Do not resend                           |
| `REVERSAL_WOULD_OVERDRAW` | Reversing a WIN/REFUND would make the balance negative (§7 rule 9)        | Do not resend; needs operator follow-up |
| `CURRENCY_MISMATCH`       | Operation currency differs from the wallet currency                       | Fix the payload                         |
| `WALLET_NOT_FOUND`        | Unknown wallet                                                            | Fix the payload                         |
| `WALLET_PLAYER_MISMATCH`  | Wallet belongs to another player                                          | Fix the payload                         |
| `REFERENCE_NOT_FOUND`     | Referenced transaction never arrived within the retry budget (ADR-0012)   | Send the reference first, or give up    |
| `REFERENCE_MISMATCH`      | Reference belongs to another provider, player, wallet, currency or round  | Fix the payload                         |
| `INVALID_REFERENCE_KIND`  | REFUND not pointing at a BET; ROLLBACK not pointing at BET, WIN or REFUND | Fix the payload                         |
| `REFERENCE_NOT_PROCESSED` | The referenced transaction is not `PROCESSED`                             | Do not resend                           |
| `ALREADY_REVERSED`        | The reference was already reverted by this kind                           | Do not resend                           |
| `AMOUNT_MISMATCH`         | Reversal amount differs from the reference amount                         | Fix the payload                         |

**HTTP status mapping (all endpoints):**

| Situation                                              | Status              | Body                                                              |
| ------------------------------------------------------ | ------------------- | ----------------------------------------------------------------- |
| Created and processed                                  | 201                 | Transaction outcome                                               |
| Idempotent replay                                      | 200                 | Original outcome, `idempotentReplay: true`                        |
| Accepted, waiting for a reference                      | 202                 | Outcome with `status: PENDING_REFERENCE`                          |
| Invalid payload or missing `Idempotency-Key`           | 400                 | Problem Details with field issues                                 |
| Resource not found (GET endpoints)                     | 404                 | Problem Details                                                   |
| Idempotency conflict; duplicate wallet                 | 409                 | Problem Details (`IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`) |
| Business rejection                                     | 422                 | Outcome with `status: REJECTED` and `failureCode`                 |
| Transient failure (database unavailable, lock timeout) | 503 + `Retry-After` | Problem Details                                                   |
| Unexpected error                                       | 500                 | Problem Details without internals                                 |

**Global exception filter.** One NestJS `ExceptionFilter`, registered with `APP_FILTER` (the analogue of
Spring's `@ControllerAdvice`), maps error classes to a status and an RFC 9457 Problem Details body
(`application/problem+json`: `type`, `title`, `status`, `detail`, `code`, `correlationId`). The mapping table
lives in one place, which keeps it consistent across endpoints.

**Validation.** Zod schemas at the edge, through NestJS 12's Standard Schema support
(`@Body({ schema })` + `StandardSchemaValidationPipe`). The **same** schemas validate the `data` of SQS messages.

**SQS side.** An `ErrorClassifier` maps the same taxonomy to ack, retry or DLQ (ADR-0010).

## Consequences

- Providers decide from the status code and `failureCode` alone, without parsing messages.
- Domain errors stay framework-free. Only the filter and the classifier know about HTTP and SQS.

## Alternatives considered

- **200 for everything with a status field.** Collapses situations the challenge requires to be distinct.
- **class-validator DTOs.** Fine for HTTP, but Zod lets SQS reuse the same contract.
