# Observability

Logs, metrics and health checks required by §12 (ADR-0015).

## Endpoints

| Process                                    | Endpoint                                                | Notes                                        |
| ------------------------------------------ | ------------------------------------------------------- | -------------------------------------------- |
| `api`                                      | `GET /metrics`, `GET /health/live`, `GET /health/ready` | On the HTTP port; unauthenticated (ADR-0014) |
| `consumer`, `outbox-relay`, `retry-worker` | `GET /metrics` on `METRICS_PORT`                        | `9464` in Compose; disabled when unset       |

Every process has its own registry, so a Prometheus scrape config lists every instance. The backlog gauges read
PostgreSQL and SQS at scrape time, so they report the same value from any instance.

## Metrics

| Metric                                     | Type      | Labels                      | Meaning                                                        |
| ------------------------------------------ | --------- | --------------------------- | -------------------------------------------------------------- |
| `wagering_transactions_total`              | counter   | `kind`, `status`, `channel` | Transactions decided (`channel`: `http`, `sqs`, `worker`)      |
| `wagering_idempotent_replays_total`        | counter   | `channel`                   | Requests answered from a stored outcome                        |
| `wagering_duplicate_messages_total`        | counter   | `consumer`                  | Queue messages already in the inbox                            |
| `wagering_message_retries_total`           | counter   | `reason`                    | Messages left for redelivery (transient failure)               |
| `wagering_dead_lettered_messages_total`    | counter   | `reason`                    | Messages moved to the DLQ                                      |
| `wagering_dead_letter_queue_messages`      | gauge     | —                           | Messages currently in the DLQ (NaN when SQS is unreachable)    |
| `wagering_lock_conflicts_total`            | counter   | —                           | Wallet lock waits that hit `DB_LOCK_TIMEOUT_MS`                |
| `wagering_outbox_lag_seconds`              | gauge     | —                           | Age of the oldest unpublished event (0 when empty)             |
| `wagering_outbox_pending_messages`         | gauge     | —                           | Events not yet published                                       |
| `wagering_outbox_published_total`          | counter   | `event_type`                | Events published                                               |
| `wagering_outbox_publish_failures_total`   | counter   | —                           | Publication attempts rescheduled with backoff                  |
| `wagering_pending_references`              | gauge     | —                           | Transactions in `PENDING_REFERENCE`                            |
| `wagering_reference_retries_total`         | counter   | `result`                    | Retry-worker attempts: processed, rejected, rescheduled        |
| `wagering_reconciliation_mismatches_total` | counter   | —                           | Wallets whose balance disagreed with their ledger              |
| `wagering_processing_duration_seconds`     | histogram | `channel`, `kind`           | Time to process one submission                                 |
| `http_request_duration_seconds`            | histogram | `method`, `route`, `status` | HTTP latency; `route` is the template, never the concrete path |
| `wagering_metrics_probe_failures_total`    | counter   | —                           | Scrapes that could not read the backlog                        |
| `process_*`, `nodejs_*`                    | various   | —                           | Default process metrics (CPU, memory, event loop)              |

Example alerts:

- `wagering_outbox_lag_seconds > 60`: the relays are down or the broker refuses publications.
- `increase(wagering_dead_lettered_messages_total[5m]) > 0`: messages need a human.
- `rate(wagering_lock_conflicts_total[5m]) > 1`: one wallet is hot, or a transaction holds its lock too long.
- `wagering_reconciliation_mismatches_total > 0`: never expected. The schema should make it impossible.

## Logs

- **Format.** One JSON object per line on stdout: `level`, `time`, `message`, then fields. Nest's own logs
  (bootstrap, routing, uncaught exceptions) use the same format, with `context`.
- **Level.** Entries below `LOG_LEVEL` (default `info`) are dropped.
- **Correlation fields.** Every line about a wager carries:

  | Field           | Present on                                                                                              |
  | --------------- | ------------------------------------------------------------------------------------------------------- |
  | `correlationId` | All of them: the `X-Correlation-Id` header (HTTP), the `messageId` (SQS), a new id per attempt (worker) |
  | `messageId`     | SQS                                                                                                     |
  | `transactionId` | Once known                                                                                              |
  | `walletId`      | All of them                                                                                             |
  | `providerId`    | All of them                                                                                             |

  The fields also give `channel`, `status` and `failureCode`. Every HTTP request adds one `http request` line
  with `method`, `route`, `status` and `durationMs`. `/health/*` and `/metrics` are measured but not logged.

- **Redaction.**
  - Values of `authorization`, `cookie`, `password`, `secret`, `token`, `apiKey`, `payload`, `body` and
    `money` become `[REDACTED]`, at any depth.
  - Errors are logged by name and message, without stacks.
  - Amounts and full payloads never reach a log line.
