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

**Logs** (revised in phase 9, see below):

- `JsonLogger` writes one JSON line per entry, honours `LOG_LEVEL`, and routes Nest's own logs through
  `NestJsonLogger`.
- The `correlationId` comes from the `X-Correlation-Id` header (or is generated) on HTTP, and is the
  `messageId` on SQS. It travels explicitly in the `RequestContext` of every use case, and from there into the
  outbox events.
- Logs carry identifiers, statuses and failure codes only. Redaction replaces credential, `payload`, `body`
  and `money` values at any depth.

**Metrics.**

- `prom-client`, one registry per process.
- The API serves `GET /metrics`; worker processes serve it on `METRICS_PORT`.
- The full catalogue is in [`docs/observability.md`](../observability.md). It covers transactions by status,
  replays and duplicates, retries, DLQ (rate and depth), lock conflicts, outbox lag and backlog, pending
  references, and processing and HTTP latency.

**Health.**

- `/health/live` reports that the process is up.
- `/health/ready` runs `SELECT 1` on PostgreSQL and `GetQueueAttributes` on the input queue.
- Both are unauthenticated.

**OpenTelemetry and dashboards** are optional and out of the core scope.

**Revision (phase 9).** The first draft named pino (`nestjs-pino`) and `AsyncLocalStorage` (`nestjs-cls`).
The implementation keeps neither:

- **Logger.** About 100 lines cover what §12 needs: JSON, levels, redaction and Nest's logs. They are fully
  unit-tested and add no dependency. Swapping in pino later means changing only `JsonLogger`.
- **Correlation.** The `correlationId` was already an explicit `RequestContext` field on every use case. Making
  it ambient would hide a dependency that the application layer now states.
- **`@nestjs/observe`.** Not adopted: plain `prom-client` is enough.

The metric names were also settled with a `wagering_` prefix.

## Consequences

- Each flow can be followed across HTTP, the database, the outbox and SQS by `correlationId`.

## Alternatives considered

- **Nest's default logger.** It does not produce structured JSON.
