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

## Implementation notes (phase 8)

- **Processes.** `test/support/processes.ts` starts the production entry point (`bun src/main.ts`) once per
  role, with its own connection pool, and can SIGKILL it (crash) or SIGTERM it (graceful). Every process is
  killed after its test.
- **Crash injection.**
  - `FAULT_CRASH_AT=<fault point>` installs `CrashAt`, which exits synchronously with code 86 at that point.
    No ack, publication mark or shutdown hook runs after it.
  - Config refuses it unless `NODE_ENV=test`, so production always runs `NoFaults`.
- **Invariant.** Every concurrency scenario ends with `assertEveryWalletConsistent`: no wallet in the database
  disagrees with its ledger.
- **SIGTERM.** Nest re-raises the signal once its shutdown hooks have run. A process that is not PID 1 (as under
  `Bun.spawn`) therefore exits with 143 after a clean shutdown; in a container it exits with 0.
- **Command.** `bun run test:concurrency`. It runs in its own CI job and is part of `verify`.
- **Finding.** Scenario 1 exposed a race in the idempotency fast path, now fixed (ADR-0008).

## Consequences

- CI only turns green when every suite has actually run against real infrastructure.
- Concurrency tests are slower and run in their own job when they arrive (phase 8).
