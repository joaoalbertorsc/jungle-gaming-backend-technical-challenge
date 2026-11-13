# Distributed Wagering Processor

Solution for the Jungle Gaming backend technical challenge: a distributed wallet and wagering transaction
processor that stays correct under duplicated, out-of-order and concurrent delivery, across several instances.

**Stack:** Bun 1.4 · TypeScript 6 (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 17 · SQS (MiniStack) ·
Docker Compose.

- Challenge statement: [`docs/CHALLENGE.md`](docs/CHALLENGE.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md) and the decision records in [`docs/adr/`](docs/adr/)
- Delivery plan and progress: [`docs/PLAN.md`](docs/PLAN.md)
- Requirements → tests: [`docs/traceability.md`](docs/traceability.md)

> **Status:** phase 0 (project setup) is complete. The domain and the wagering flows land phase by phase; see the plan.

## Prerequisites

- Docker with Docker Compose v2
- git

Nothing else is installed on the host. Bun, PostgreSQL and the SQS emulator all run in containers.

## Quick start

```bash
# Build the image, apply migrations, create the queues and start the HTTP API
docker compose up -d --build api

# Liveness check
curl http://localhost:3000/health/live
```

## Try it

```bash
# Create a wallet with 100.00 BRL
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Bet 25.00 on it (replace WALLET_ID); repeat the same call to see the idempotent replay
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"WALLET_ID","roundId":"r-1","gameId":"g-1","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

Endpoints, status codes and error codes: [`docs/API.md`](docs/API.md).

## Development and tests

All tooling runs in the `workspace` container, with the source bind-mounted.

```bash
# First run after cloning: install dependencies (writes node_modules into the project folder)
docker compose run --rm workspace bun install --frozen-lockfile

# Everything CI checks: focused-test guard, format, lint, typecheck and all test suites
docker compose run --rm workspace bun run verify

# Individual suites
docker compose run --rm workspace bun run test:unit
docker compose run --rm workspace bun run test:unit:coverage
docker compose run --rm workspace bun run test:integration
docker compose run --rm workspace bun run test:e2e
```

Integration and e2e suites run against real PostgreSQL and MiniStack containers, which `workspace` starts
automatically. They fail, never skip, when the infrastructure is unavailable. Each test file runs in its own
throwaway database (`test_*`), cloned from a migrated template (`wagering_template`). Run
`docker compose down --volumes` to reset everything.

## Useful commands

| Command                                                    | Purpose                                   |
| ---------------------------------------------------------- | ----------------------------------------- |
| `docker compose run --rm migrate`                          | Apply pending migrations                  |
| `docker compose run --rm workspace bun run migration:down` | Revert the last migration (test database) |
| `docker compose run --rm sqs-init`                         | (Re)create the queues                     |
| `docker compose logs -f api`                               | Follow API logs                           |
| `docker compose up -d --scale consumer=3 consumer`         | Run three SQS consumer instances          |
| `docker compose down --volumes`                            | Stop everything and drop the data volumes |

## Host ports

| Service         | Default | Override             |
| --------------- | ------- | -------------------- |
| API             | 3000    | `API_HOST_PORT`      |
| PostgreSQL      | 55432   | `POSTGRES_HOST_PORT` |
| MiniStack (SQS) | 4566    | `SQS_HOST_PORT`      |

Copy `.env.example` to `.env` to change them. Credentials in `compose.yml` are local-only test values.

## Continuous integration

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every pull request and every
push to `main`:

1. Quality: focused-test guard, format, lint, typecheck
2. Unit tests with a coverage threshold
3. Integration and e2e tests inside the same compose workspace
4. Production image build
