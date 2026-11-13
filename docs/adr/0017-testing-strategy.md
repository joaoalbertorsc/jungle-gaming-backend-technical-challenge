# ADR-0017: TDD and the testing strategy

- Status: Accepted
- Date: 2026-11-12

## Context

The challenge requires unit tests, integration tests against **real** PostgreSQL and SQS containers, and
concurrency tests with **real parallelism**, all ending with the invariant
`wallet.balance == balance rebuilt from the ledger` (§13). Tests that replace PostgreSQL and SQS entirely with
mocks are an eliminatory failure (§14).

## Decision

**Process.**

- TDD with `bun test`: red → green → refactor.
- The cycle is visible in history: `test:` commits (red), then `feat:` (green), then `refactor:`.

**Layout:**

| Folder             | Scope                                                                               | Infrastructure      |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------- |
| `test/unit`        | Domain and application rules: pure, deterministic `Clock`/`IdGenerator`             | None                |
| `test/integration` | Constraints, repositories, atomicity, inbox/outbox, consumer, DLQ, restart recovery | Real Postgres + SQS |
| `test/e2e`         | HTTP contract: status codes, replay, conflict, Problem Details                      | Real stack          |
| `test/concurrency` | The 8 mandatory scenarios, including ≥ 3 processes started with `Bun.spawn`         | Real stack          |
| `test/load`        | Optional `bun run test:load`                                                        | Real stack          |
| `test/support`     | Builders, fixtures, the `assertLedgerMatchesBalance` helper, process harness        | —                   |

**Rules.**

- **No mocks of PostgreSQL or SQS** outside unit tests of pure code.
- **No silent skips.** Integration suites fail, never skip, when infrastructure is missing.
- **No focused or skipped tests.** `scripts/check-focused-tests.ts` rejects `.only`, `.skip`, `.skipIf` and
  `.if` in CI.
- **Invariant check.** Every integration and concurrency test ends with `assertLedgerMatchesBalance`.
- **Fault injection.** Environment-gated hooks, active only in tests, simulate a crash after commit and before
  ack.
- **Isolation.** Each test file gets its own database, cloned from a migrated template
  (`CREATE DATABASE ... TEMPLATE`), plus queue names unique to the run.
- **Coverage.** The unit suite enforces at least 90% lines and functions (`bunfig.toml`).

**Traceability.** `docs/traceability.md` maps every challenge requirement to the code that enforces it and the
tests that prove it. Every PR lists the requirements it covers, and the last phase is a full requirements audit.

**Why not Testcontainers.** Tests run inside the `workspace` container, so Testcontainers would need
Docker-in-Docker. Compose services give the same real containers, with parity between local runs and CI.

## Consequences

- CI only turns green when every suite has actually run against real infrastructure.
- Concurrency tests are slower and run in their own job when they arrive (phase 8).
