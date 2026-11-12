# ADR-0002: Runtime, language and container-only toolchain

- Status: Accepted
- Date: 2026-11-12

## Context

The challenge mandates Bun 1.x (runtime, package manager and test runner), strict TypeScript, NestJS,
PostgreSQL, SQS through an emulator, and Docker Compose. Reviewers and CI must reproduce the environment
exactly, and the development host should not need any toolchain installed.

## Decision

| Concern                           | Choice                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Runtime / package manager / tests | Bun 1.4.4                                                                                            |
| Language                          | TypeScript 6.0, `strict`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns` |
| Framework                         | NestJS 12                                                                                            |
| Database                          | PostgreSQL 17                                                                                        |
| Messaging                         | SQS through MiniStack (ADR-0016)                                                                     |
| Lint / format                     | ESLint `strictTypeChecked` + Prettier                                                                |

- **TypeScript 6.0 rather than 7.** TypeScript 7 (the native compiler) is out, but typescript-eslint
  supports `< 6.1`. Type-aware lint rules such as `no-floating-promises` matter more here than compiler speed.
- **No build step.** Bun executes TypeScript directly, including the legacy decorators and decorator
  metadata NestJS relies on. The runtime image ships the sources.
- **Container-only workflow.** Everything runs through `docker compose`: Postgres, MiniStack, the one-shot
  `migrate` and `sqs-init` services, the `api` role, and a `workspace` container (`tools` profile) that runs
  install, lint, typecheck and every test suite with the source bind-mounted. The host needs Docker and git only.
- **Dev Container deferred.** It is optional; it can be added later without touching anything else.

## Consequences

- CI runs the same compose services and the same commands as a local run.
- `node_modules` is installed by the container into the bind-mounted folder, so IDEs can still index it.
- Bind-mount I/O is slower on Windows hosts. This affects speed, not correctness.

## Alternatives considered

- **Node.js + Jest.** Not allowed: Bun is mandatory.
- **Biome instead of ESLint.** Faster, but its type-aware rules are less mature than typescript-eslint's.
