# Final requirements audit

Phase 13, 2026-11-14. Each challenge requirement is mapped to code and tests in
[`traceability.md`](traceability.md). This page checks the eliminatory failures (§14) one by one, then the
scoring areas, and lists what is not delivered.

At the time of the audit, `bun run verify` passes. It runs format, lint, typecheck, the unit tests with ≥ 90%
per-file coverage, integration and e2e, and the concurrency suite. CI runs the same suites on every PR.

## Eliminatory failures

| §14 eliminatory failure                     | Verdict | Evidence                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number` for money                          | Clear   | `Money` holds `bigint` minor units, and amounts cross every boundary as decimal strings. A source scan finds no `parseFloat`, `toFixed` or numeric amount field. The `money_amount` domain rejects excess decimals rather than rounding them (ADR-0005). |
| Negative balance caused by a race           | Clear   | The wallet row lock covers every read → decide → write; `money_amount` refuses negatives. Concurrency scenario 2 (§8: 2 × 80.00 on 100.00 across two processes) and scenario 4 (60 concurrent debits) end exact.                                         |
| Duplicated debit or credit                  | Clear   | Persistent idempotency, the inbox, a single-reversal unique index and the ledger version chain. Scenario 1 (50 identical bets over 3 processes: one debit), scenario 5 (crash after commit, before ack) and scenario 8 (kills and restarts).             |
| Idempotency only in memory                  | Clear   | The key, payload hash and outcome are stored in `wager_transactions`, and the inbox is a table. No cache exists (ADR-0008, ADR-0010).                                                                                                                    |
| Correct only with one instance              | Clear   | Stateless processes, with all coordination in PostgreSQL. The concurrency suite runs 3 API processes, 3 consumers, 2 relays and a retry worker as separate OS processes.                                                                                 |
| Event published before commit               | Clear   | Events exist only as outbox rows in the business transaction; relays publish committed rows only. `outbox-relay.spec.ts` shows a rollback publishes nothing (ADR-0011).                                                                                  |
| No auditable ledger                         | Clear   | `wallet_ledger_entries` is append-only and chained by wallet version. A deferred trigger checks balance == ledger at commit. Exposed by `GET /wallets/:id/ledger`, with reconciliation at `POST /wallets/:id/reconciliation`.                            |
| Tests replacing PostgreSQL and SQS by mocks | Clear   | Integration, e2e and concurrency suites run against real PostgreSQL 17 and MiniStack containers, and fail instead of skipping without them (ADR-0017).                                                                                                   |

## Scoring areas

| Area (points)                   | Where it is addressed                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Financial correctness (20)      | `Money`, `Wallet`, `WagerTransactionProcessor` (§7 rules, documented interpretations); schema invariants; reconciliation        |
| Concurrency (20)                | ARCHITECTURE.md §8; ADR-0007; `test/concurrency/` (8 scenarios, ≥ 3 processes)                                                  |
| Idempotency (15)                | ADR-0008; replay with the stored outcome and balance; 409 for divergent payload or reused external id                           |
| Messaging and failures (15)     | Inbox, outbox relay, retry worker, DLQ, visibility backoff, crash injection, graceful shutdown                                  |
| Modelling and architecture (10) | Hexagonal modules, a framework-free domain (enforced by a test), ports for every adapter; 18 ADRs                               |
| Tests (10)                      | TDD history (red → green commits); real infrastructure; races and crashes as processes; ledger invariant everywhere             |
| Observability (5)               | JSON logs with correlation and redaction, Prometheus metrics on every process, liveness and readiness (`docs/observability.md`) |
| Documentation (5)               | README (setup, commands), ARCHITECTURE (decisions, trade-offs, limitations), API, diagrams, traceability                        |

## Not delivered

- **Load test** (`bun run test:load`, optional): cut for time; throughput and latency percentiles were not
  measured.
- **Keycloak authentication** (optional): only the extension point exists, as a global guard over `AuthPort`
  that currently allows all. The JWT design is in ADR-0014.
- **Required status checks** on GitHub: not available for a private repository on the Free plan. "Merge only
  on green" was applied by the delivery script (ADR-0018).

## Findings during delivery

- **Fast-path idempotency race (fixed).** Concurrency scenario 1 showed an identical retry answered
  `409 EXTERNAL_ID_REUSED`. The cause was two lookups under separate snapshots; they now share one snapshot
  (ADR-0008).
