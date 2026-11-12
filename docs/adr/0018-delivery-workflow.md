# ADR-0018: Documentation, git workflow and CI

- Status: Accepted
- Date: 2026-11-12

## Context

Documentation is evaluated (§14: a `README.md` with setup and commands, an `ARCHITECTURE.md` with decisions,
trade-offs and limitations). The history of how the solution was built should stay readable, since it is part
of how the work is presented.

## Decision

**Documentation.** In English:

- `README.md` and `ARCHITECTURE.md`;
- `docs/` for ADRs, diagrams (Mermaid, rendered by GitHub), the plan, traceability and the original challenge;
- a Portuguese `README.pt-BR.md` is optional at the end.

**Git.**

- Private repository.
- One branch per feature or phase, named `<type>/<phase>-<slug>` (for example `feat/01-domain-money`).
- Conventional Commits with meaningful bodies.
- One PR per branch, following `.github/pull_request_template.md`.
- **Merge commits, not squash**, so the TDD trail survives on `main`.
- **Branches are never deleted** after merge.

**CI.** GitHub Actions on every PR and push to `main`:

- quality: focused-test guard, format, lint, typecheck;
- unit tests with coverage;
- integration and e2e tests in the same `docker compose` workspace used locally;
- production image build.

A PR is merged as soon as every check is green, never with a red or pending check.

**Local automation.** Helper scripts for repetitive loops (push → wait for CI → merge) live in the working copy
and are excluded through `.git/info/exclude`, so they never reach the repository.

## Consequences

- **Known limitation.** On GitHub Free, private repositories cannot enforce required status checks. "Merge only
  on green" is enforced by process until the repository goes public, when branch protection can be switched on.
- `bun run verify` reproduces the CI checks locally before each PR.
