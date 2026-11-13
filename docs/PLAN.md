# Delivery plan

The window is 48 hours from 2026-11-12. Each phase is timeboxed and ships as one branch and PR, following
TDD (ADR-0017) and the delivery workflow (ADR-0018). Phases 11 and 12 are the cut line if the schedule slips.

| Phase | Deliverable                           | Hours | Cumulative | Status  |
| ----- | ------------------------------------- | ----- | ---------- | ------- |
| 0     | Project setup                         | 3     | 3          | ✅ Done |
| 1     | Domain model                          | 4     | 7          | ✅ Done |
| 2     | Schema and migrations                 | 4     | 11         | ✅ Done |
| 3     | Use cases                             | 6     | 17         | ✅ Done |
| 4     | HTTP API                              | 3     | 20         | ✅ Done |
| 5     | SQS consumer                          | 4     | 24         | ✅ Done |
| 6     | Outbox relay                          | 3     | 27         | ⬜      |
| 7     | Pending-reference worker              | 2     | 29         | ⬜      |
| 8     | Concurrency suite                     | 5     | 34         | ⬜      |
| 9     | Observability                         | 2     | 36         | ⬜      |
| 10    | Documentation consolidation           | 3     | 39         | ⬜      |
| 11    | Load test (optional)                  | 2     | 41         | ⬜      |
| 12    | Keycloak authentication (optional)    | 3     | 44         | ⬜      |
| 13    | Final requirements audit and delivery | 2     | 46         | ⬜      |
| —     | Buffer                                | 2     | 48         |         |

## Phase 0: Project setup ✅

- [x] Own git repository and private GitHub repository
- [x] Bun + NestJS + strict TypeScript scaffold; ESLint (type-checked) and Prettier
- [x] Docker Compose: Postgres (two roles), MiniStack, `migrate`, `sqs-init`, `api`, `workspace`
- [x] Spike: MikroORM 7 migrations (up/down) on Bun
- [x] SQS emulator contract tests (MiniStack passes all)
- [x] Config validation and `/health/live` (TDD)
- [x] CI: quality, unit, infra (compose), image build; PR template
- [x] ADRs, diagrams, plan and traceability matrix

## Phase 1: Domain model ✅

- [x] `Money` (parsing, arithmetic, comparisons, currency mismatch, serialization)
- [x] `Wallet` aggregate (open, debit, credit, version rules, invariants)
- [x] `WalletLedgerEntry` (structural immutability, balanced arithmetic)
- [x] `WagerTransaction` (state machine, reference rules per kind, payload match)
- [x] Business rules per kind (BET, WIN, LOSS, REFUND, ROLLBACK) and failure-code taxonomy
- [x] `IntegrationEvent` base class and the four events; `InboxMessage`, `OutboxMessage`
- [x] Canonical JSON + `payloadHash`
- [x] Dependency-rule test (the domain imports nothing from frameworks)

## Phase 2: Schema and migrations ✅

- [x] Constraint tests first (negative balance, duplicate wallet, ledger update/delete, double reversal, ...)
- [x] Migrations for every table, with `up` and `down`, grants for the app role, immutability triggers
- [x] Ledger version-chain trigger adopted (ADR-0006)
- [x] Per-test-file template database harness

## Phase 3: Use cases ✅

- [x] Transaction runner port and MikroORM implementation; repositories and mappers
- [x] `CreateWallet` (OPENING transaction + CREDIT entry in the same transaction)
- [x] `SubmitWagerTransaction` (wallet lock, idempotency, rules, outcome snapshot, outbox)
- [x] Queries (wallet, ledger cursor, transaction by id and by provider id)
- [x] `ReconcileWallet`

## Phase 4: HTTP API ✅

- [x] Nest wiring of the use cases (factories, no decorators in the application layer)
- [x] Controllers and Zod schemas (Standard Schema pipe)
- [x] Global exception filter + Problem Details; status mapping (ADR-0009)
- [x] `/health/ready`

## Phase 5: SQS consumer ✅

- [x] Long-polling consumer, inbox in the same transaction, ack after commit
- [x] Error classification, visibility backoff, explicit DLQ for permanent errors
- [x] Graceful shutdown on SIGTERM

## Phase 6: Outbox relay

- [ ] Claim with `SKIP LOCKED` + lease; publish; mark published; retry with backoff
- [ ] Reference event consumer deduplicating by `eventId`

## Phase 7: Pending-reference worker

- [ ] Claim due rows, backoff, exhaustion to `REFERENCE_NOT_FOUND`, nudge on reference arrival

## Phase 8: Concurrency suite

- [ ] The 8 mandatory scenarios (§13) with real parallelism and ≥ 3 processes; final ledger invariant

## Phase 9: Observability

- [ ] Structured logs with correlation, redaction, Prometheus metrics

## Phase 10: Documentation consolidation

- [ ] `ARCHITECTURE.md` (decisions, trade-offs, limitations), README commands, sequence/state/ER diagrams

## Phase 11 (optional): Load test

- [ ] `bun run test:load` with methodology, throughput, p50/p95/p99, error rate, conflicts, outbox lag

## Phase 12 (optional): Keycloak

- [ ] Client Credentials, JWT guard, provider identity check (ADR-0014)

## Phase 13: Final requirements audit

- [ ] Walk every row of `docs/traceability.md` and every eliminatory failure against code and tests; close gaps
