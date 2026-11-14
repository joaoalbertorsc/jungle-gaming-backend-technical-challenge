# Distributed Wagering Processor

Solution for the Jungle Gaming backend technical challenge: a distributed wallet and wagering transaction
processor that stays correct under duplicated, out-of-order and concurrent delivery, across several instances.

**Stack:** Bun 1.4 · TypeScript 6 (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 17 · SQS (MiniStack) ·
Docker Compose.

- Challenge statement: [`docs/CHALLENGE.md`](docs/CHALLENGE.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md) and the decision records in [`docs/adr/`](docs/adr/)
- Delivery plan and progress: [`docs/PLAN.md`](docs/PLAN.md)
- Requirements → tests: [`docs/traceability.md`](docs/traceability.md)
- Final audit (eliminatory failures, gaps): [`docs/audit.md`](docs/audit.md)

> **Status:** feature-complete for the mandatory scope: HTTP and SQS entry points, outbox relay, retry worker,
> the concurrency suite and observability. The optional load test and Keycloak integration are not included;
> see [`docs/traceability.md`](docs/traceability.md).

## Prerequisites

- Docker with Docker Compose v2
- git

Nothing else is installed on the host. Bun, PostgreSQL and the SQS emulator all run in containers.

## Quick start

```bash
# Build the image and start the whole system in the background
docker compose up -d --build

# Ready when PostgreSQL and SQS answer
curl http://localhost:3000/health/ready
```

Then open **http://localhost:3000/docs** to explore and test the API in the browser (next section).

`docker compose up` runs the application only; the test suites run on demand (see
[Development and tests](#development-and-tests)). Services start in this order:

| Service                                    | Role                                                       | Lifetime      |
| ------------------------------------------ | ---------------------------------------------------------- | ------------- |
| `postgres`, `ministack`                    | PostgreSQL 17 and the SQS emulator                         | Keep running  |
| `migrate`, `sqs-init`                      | Apply migrations; create the FIFO queues and the DLQ       | Exit with 0   |
| `api`                                      | HTTP API on port 3000, Swagger UI, `/metrics`              | Keeps running |
| `consumer`, `outbox-relay`, `retry-worker` | SQS consumer, event publisher, `PENDING_REFERENCE` retries | Keep running  |

To start only the HTTP API and what it needs, use `docker compose up -d --build api`. The `202 PENDING_REFERENCE`
scenario below then stays pending, because no retry worker runs.

## API documentation and interactive testing (Swagger / OpenAPI)

The API documents itself with OpenAPI 3, and Swagger UI can execute every operation from the browser. No curl
or Postman is needed.

| URL                                | Content                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| http://localhost:3000/docs         | Swagger UI: browse, read and execute every endpoint                       |
| http://localhost:3000/openapi.json | The OpenAPI 3 document (JSON), for Postman, Insomnia or client generators |
| http://localhost:3000/openapi.yaml | The same document in YAML                                                 |

### What it shows

- **Every endpoint**, grouped into **Wallets**, **Wagering**, **Health** and **Observability**, each with a
  summary and the business rules that apply.
- **Inputs:** request bodies, path and query parameters, with their types and limits (max lengths, UUID
  formats, kinds, page size). It also covers the headers: `Idempotency-Key` (required on submissions) and
  `X-Correlation-Id` (optional).
- **Every response status of every endpoint**, with its body schema:
  - **201:** processed;
  - **200:** idempotent replay;
  - **202:** pending reference;
  - **422:** rejected by a business rule, with `failureCode`;
  - **400, 404, 409:** Problem Details with a stable `code`;
  - **503:** retry later.
- **Ready-to-send examples:**
  - two for `POST /wallets`;
  - one per wager kind for `POST /wagering/transactions` (BET, WIN, LOSS, REFUND, ROLLBACK). They chain from
    the same BET (`bet-1001`).
- **A "try it in three steps" guide** at the top of the page.

### Walkthrough: test the main scenarios in the browser

In Swagger UI, expand an operation and press **Execute**: "Try it out" is already on. Pick a body in the
**Examples** drop-down, edit it, then read the status, body and headers below. The amounts are those of the
examples.

| #   | Operation                                                 | What to send                                                                                                                                           | Expected result                                                                                                                             |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /wallets`                                           | Example _Wallet with 100.00 BRL_                                                                                                                       | **201** with the wallet `id` (copy it); balance `100.00`, `version: 1`                                                                      |
| 2   | `POST /wagering/transactions`                             | Example `bet`; paste the wallet `id` into `walletId`; `Idempotency-Key: provider-a:bet-1001`                                                           | **201** `PROCESSED`, balance `75.00`                                                                                                        |
| 3   | same                                                      | Execute again, unchanged                                                                                                                               | **200** with the same `transactionId` and `idempotentReplay: true`; the balance does not move                                               |
| 4   | same                                                      | Same key, change the amount to `30.00`                                                                                                                 | **409** `IDEMPOTENCY_CONFLICT`, reason `PAYLOAD_MISMATCH`: never a replay                                                                   |
| 5   | same                                                      | Example `win`, key `provider-a:win-1001`                                                                                                               | **201**, balance `115.00`                                                                                                                   |
| 6   | same                                                      | Example `rollback` (reverses the WIN), key `provider-a:rollback-1001`                                                                                  | **201**, balance `75.00`                                                                                                                    |
| 7   | same                                                      | Example `refund` with `externalTransactionId: refund-2002` and `referenceExternalTransactionId: bet-2002` (not sent yet), key `provider-a:refund-2002` | **202** `PENDING_REFERENCE`: the reference has not arrived                                                                                  |
| 8   | same                                                      | Example `bet` with `externalTransactionId: bet-2002`, key `provider-a:bet-2002`                                                                        | **201**, balance `50.00`; the retry worker now settles the REFUND                                                                           |
| 9   | `GET /providers/.../transactions/{externalTransactionId}` | `provider-a` / `refund-2002`                                                                                                                           | `PROCESSED`, `resultingBalance` `75.00`                                                                                                     |
| 10  | `POST /wagering/transactions`                             | Example `bet` with a new id and amount `9999.00`                                                                                                       | **422** `REJECTED`, `failureCode: INSUFFICIENT_FUNDS`; balance unchanged                                                                    |
| 11  | same                                                      | Any body without the `Idempotency-Key` header                                                                                                          | **400** `IDEMPOTENCY_KEY_REQUIRED`                                                                                                          |
| 12  | `GET /wallets/{walletId}/ledger`                          | The wallet `id`                                                                                                                                        | One entry per balance move: `CREDIT 100.00`, `DEBIT 75.00`, `CREDIT 115.00`, `DEBIT 75.00`, `DEBIT 50.00`, `CREDIT 75.00` (versions 1 to 6) |
| 13  | `POST /wallets/{walletId}/reconciliation`                 | The wallet `id`                                                                                                                                        | **200**, `consistent: true`, difference `0.00`, `checkedEntries: 6`                                                                         |

`X-Correlation-Id` is optional. When it is empty, the API mints one and returns it in the response headers. The
same id appears in the logs and in the events of that request.

Tip: the lamp icon at the top of Swagger UI switches between the light and dark themes. The page follows the
system theme by default.

### How the document stays accurate

- **Inputs are not written twice.** Bodies, path and query parameters come from the same Zod schemas that
  validate the requests, so the document cannot accept what the API refuses, or the opposite.
- **Responses are checked against reality.** The response schemas sit next to each controller
  (`*.openapi.ts`). The e2e suite [`test/e2e/openapi.e2e.spec.ts`](test/e2e/openapi.e2e.spec.ts) parses real
  responses with them (201, 200, 202, 422, 400, 404, 409 and the health probes). It also checks that the
  document lists exactly the served endpoints, with every status, without duplicated parameters. A response
  that changes without its documentation fails CI.
- **Built with** `@nestjs/swagger`, wired in
  [`src/shared/interface/http/openapi.ts`](src/shared/interface/http/openapi.ts).
- **Unauthenticated.** `/docs` and `/openapi.*` are open, like the health probes; authentication is deferred
  (ADR-0014).

### With curl

The same first steps from a terminal:

```bash
# Create a wallet with 100.00 BRL and keep its id
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Bet 25.00 on it (replace WALLET_ID); repeat the same call to see the idempotent replay
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"WALLET_ID","roundId":"r-1","gameId":"g-1","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

Endpoint reference in Markdown, with status and error codes: [`docs/API.md`](docs/API.md).

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
docker compose run --rm workspace bun run test:concurrency
```

Integration and e2e suites run against real PostgreSQL and MiniStack containers, which `workspace` starts
automatically. They fail, never skip, when the infrastructure is unavailable. Each test file runs in its own
throwaway database (`test_*`), cloned from a migrated template (`wagering_template`). The concurrency suite
starts every role as a separate OS process (`bun src/main.ts`), then kills and restarts them mid-test (§13). Run
`docker compose down --volumes` to reset everything.

## Observability

- `GET /metrics` on the API, and on `METRICS_PORT` (9464) for worker processes, in Prometheus format.
- `GET /health/live` and `GET /health/ready`.
- Logs are JSON lines carrying `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId`, never
  amounts.
- Metric catalogue, log fields and example alerts: [`docs/observability.md`](docs/observability.md).

## Useful commands

| Command                                                    | Purpose                                           |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `docker compose run --rm migrate`                          | Apply pending migrations                          |
| `docker compose run --rm workspace bun run migration:down` | Revert the last migration (test database)         |
| `docker compose run --rm sqs-init`                         | (Re)create the queues                             |
| `docker compose logs -f api`                               | Follow API logs                                   |
| `docker compose up -d --scale consumer=3 consumer`         | Run three SQS consumer instances                  |
| `docker compose up -d outbox-relay`                        | Publish outbox events to `wagering-events.fifo`   |
| `docker compose up -d retry-worker`                        | Retry `PENDING_REFERENCE` transactions (ADR-0012) |
| `docker compose down --volumes`                            | Stop everything and drop the data volumes         |

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
2. Unit tests with a 90% per-file coverage threshold
3. Integration and e2e tests inside the same compose workspace, including the OpenAPI drift guard
4. Concurrency suite: every role as a separate process, with crashes and restarts
5. Production image build
