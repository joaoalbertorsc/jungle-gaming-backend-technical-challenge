# ADR-0015: Structured logs, metrics and health checks

- Status: Accepted
- Date: 2026-11-12

## Context

The challenge requires (§12):

- structured JSON logs carrying `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId`;
- no sensitive data and no full financial payloads in logs;
- metrics for transactions by status, duplicates detected, retries, DLQ messages, lock conflicts, outbox lag
  and processing latency;
- separate liveness and readiness checks.

## Decision

**Logs.**

- pino JSON through `nestjs-pino`.
- The `correlationId` comes from the `X-Correlation-Id` header (or is generated). It propagates through
  `AsyncLocalStorage` (`nestjs-cls`) into use cases, outbox events and SQS message attributes.
- Logs carry identifiers, statuses and failure codes only. Redaction rules strip request bodies, amounts and
  authorization headers.

**Metrics.** `prom-client` exposes `/metrics`:

- `wager_transactions_total{kind,status,channel}`
- `idempotency_duplicates_total{channel}`
- `retries_total{stage}`
- `dlq_messages_total{reason}`
- `wallet_lock_conflicts_total`
- `outbox_lag_seconds`
- `processing_duration_seconds` (histogram)
- `reconciliation_mismatches_total`

**Health.**

- `/health/live` reports that the process is up.
- `/health/ready` runs `SELECT 1` on PostgreSQL and `GetQueueAttributes` on the input queue.
- Both are unauthenticated.

**OpenTelemetry and dashboards** are optional and out of the core scope. NestJS 12's `@nestjs/observe` will
be evaluated in phase 9.

## Consequences

- Each flow can be followed across HTTP, the database, the outbox and SQS by `correlationId`.

## Alternatives considered

- **Nest's default logger.** It does not produce structured JSON.
