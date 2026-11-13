# Requirements traceability

Every requirement of the challenge ([`CHALLENGE.md`](CHALLENGE.md)), where it is enforced, and the tests that
prove it. Each PR updates the rows it touches, and the final audit (phase 13) walks the whole table.

Status: ✅ done · 🟡 partial · ⬜ pending

## §2 Authentication

| ID    | Requirement                                                 | Enforced by        | Tests                         | Status                      |
| ----- | ----------------------------------------------------------- | ------------------ | ----------------------------- | --------------------------- |
| R-2.1 | Health endpoints are unauthenticated                        | `HealthController` | `test/e2e/health.e2e.spec.ts` | 🟡 live done, ready pending |
| R-2.2 | Auth decision documented, explicit extension point in code  | ADR-0014           | —                             | 🟡 documented               |
| R-2.3 | Provider identity in messages still validated by the domain |                    |                               | ⬜                          |

## §3 Global invariants

| ID    | Requirement                                                   | Enforced by | Tests | Status |
| ----- | ------------------------------------------------------------- | ----------- | ----- | ------ |
| R-3.1 | No duplicated credits or debits                               |             |       | ⬜     |
| R-3.2 | No lost confirmed events                                      |             |       | ⬜     |
| R-3.3 | No negative balance                                           |             |       | ⬜     |
| R-3.4 | Correct under duplicate, out-of-order and concurrent delivery |             |       | ⬜     |

## §4 Stack

| ID    | Requirement                                                  | Enforced by                                  | Tests                                                           | Status                     |
| ----- | ------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| R-4.1 | Bun 1.x as runtime, package manager and test runner          | `package.json`, `Dockerfile`, CI             | all suites                                                      | ✅                         |
| R-4.2 | TypeScript strict mode                                       | `tsconfig.json`, CI typecheck                | CI `quality` job                                                | ✅                         |
| R-4.3 | NestJS                                                       | `src/`                                       | `test/e2e/health.e2e.spec.ts`                                   | ✅                         |
| R-4.4 | PostgreSQL                                                   | `compose.yml`                                | integration suites                                              | ✅                         |
| R-4.5 | SQS via LocalStack or MiniStack                              | `compose.yml`, ADR-0016                      | `test/integration/infrastructure/sqs-emulator.contract.spec.ts` | ✅                         |
| R-4.6 | Docker Compose orchestration                                 | `compose.yml`                                | CI `infra` job                                                  | ✅                         |
| R-4.7 | Versioned and reversible migrations                          | 4 SQL migrations with `up`/`down` (ADR-0004) | `test/integration/database/migrations.spec.ts`                  | ✅                         |
| R-4.8 | ORM choice, Money mapping and transaction strategy justified | ADR-0004, ADR-0005                           | —                                                               | 🟡 ARCHITECTURE.md pending |

## §5 Inviolable restrictions

| ID    | Requirement                                            | Enforced by                                            | Tests                                                                                       | Status |
| ----- | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| R-5.1 | No `number`/`float`/`double` for money                 | `Money` (`bigint`), `money_amount` domain              | `test/unit/shared/domain/money.spec.ts`, `test/integration/database/wallets.schema.spec.ts` | ✅     |
| R-5.2 | No in-memory cache as the idempotency guarantee        |                                                        |                                                                                             | ⬜     |
| R-5.3 | Not relying on SQS FIFO alone for consistency          |                                                        |                                                                                             | ⬜     |
| R-5.4 | No event published before commit                       |                                                        |                                                                                             | ⬜     |
| R-5.5 | Ledger entries never updated or deleted                | Append-only triggers + no `UPDATE`/`DELETE` grant      | `test/integration/database/ledger.schema.spec.ts`                                           | ✅     |
| R-5.6 | No global lock shared by all wallets                   |                                                        |                                                                                             | ⬜     |
| R-5.7 | No unguarded read → calculate → update                 |                                                        |                                                                                             | ⬜     |
| R-5.8 | Correct with multiple instances                        |                                                        |                                                                                             | ⬜     |
| R-5.9 | Uniqueness, immutability, non-negativity in the schema | Constraints, partial unique index, triggers (ADR-0006) | `test/integration/database/*.schema.spec.ts`                                                | ✅     |

## §6 Domain model

| ID     | Requirement                                                                      | Enforced by                                                     | Tests                                                                                                                     | Status                                   |
| ------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| R-6.0  | Private constructors + static factories; `rehydrate` does not re-validate        | All aggregates and value objects                                | `rehydrate()` cases in the wallet, ledger, transaction, inbox and outbox specs                                            | ✅                                       |
| R-6.1a | Money immutable; fixed scale 2; decimal string in and out                        | `Money`                                                         | `test/unit/shared/domain/money.spec.ts`                                                                                   | ✅                                       |
| R-6.1b | Money rejects NaN, Infinity, scientific notation, empty, > 2 decimals, negatives | `Money.from`                                                    | `test/unit/shared/domain/money.spec.ts`                                                                                   | ✅                                       |
| R-6.1c | Operations across currencies raise a domain error                                | `Money`, `Wallet`                                               | `test/unit/shared/domain/money.spec.ts`, `test/unit/modules/wallet/domain/wallet.spec.ts`                                 | ✅                                       |
| R-6.1d | Domain independent of ORM types and NestJS decorators                            | Dependency rule (ADR-0003)                                      | `test/unit/architecture/dependency-rule.spec.ts`                                                                          | ✅                                       |
| R-6.2a | At most one wallet per `playerId` + `currency`                                   | `UNIQUE (player_id, currency)`                                  | `test/integration/database/wallets.schema.spec.ts`                                                                        | ✅                                       |
| R-6.2b | Balance never negative                                                           | `Wallet.debit`; `money_amount` domain (>= 0)                    | wallet unit spec, `test/integration/database/wallets.schema.spec.ts`                                                      | ✅                                       |
| R-6.2c | Every balance change has a ledger entry, and vice versa                          | `Wallet`; ledger chain + deferred balance check (ADR-0006)      | wallet unit spec, `test/integration/database/wallets.schema.spec.ts`, `test/integration/database/ledger.schema.spec.ts`   | ✅                                       |
| R-6.2d | No lost update under concurrency                                                 |                                                                 |                                                                                                                           | ⬜                                       |
| R-6.2e | Operation currency equals the wallet currency                                    | `Wallet`, `WagerTransactionProcessor`                           | `test/unit/modules/wallet/domain/wallet.spec.ts`, `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts` | ✅                                       |
| R-6.2f | `version` starts at 1, increments only when the balance changes                  | `Wallet`                                                        | `test/unit/modules/wallet/domain/wallet.spec.ts`                                                                          | ✅                                       |
| R-6.3a | Explicit, documented transitions; terminal states immutable                      | `WagerTransaction`; `docs/diagrams/wager-transaction-states.md` | `test/unit/modules/wagering/domain/wager-transaction.spec.ts`                                                             | ✅                                       |
| R-6.3b | `OPENING` is internal (rejected from API and queue)                              | `WagerTransaction.create`                                       | `test/unit/modules/wagering/domain/wager-transaction.spec.ts`                                                             | 🟡 domain done; API/queue paths pending  |
| R-6.3c | Same idempotency key with a different payload is a conflict                      | `computePayloadHash`, `matchesPayload`                          | `test/unit/modules/wagering/domain/wager-payload.spec.ts`                                                                 | 🟡 domain done; conflict flow in phase 3 |
| R-6.4a | Ledger entry structurally immutable; factory validates arithmetic                | `WalletLedgerEntry`; append-only triggers; balanced CHECK       | ledger unit spec, `test/integration/database/ledger.schema.spec.ts`                                                       | ✅                                       |
| R-6.4b | At most one ledger entry per wallet per transaction                              | `UNIQUE (transaction_id, wallet_id)`                            | `test/integration/database/ledger.schema.spec.ts`                                                                         | ✅                                       |
| R-6.4c | `LOSS` and `REJECTED` produce no ledger entry                                    | `WagerTransactionProcessor`                                     | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                                                   | ✅                                       |
| R-6.5  | Inbox, financial change, ledger and outbox in the same SQL transaction           |                                                                 |                                                                                                                           | ⬜                                       |

## §7 Business rules

| ID     | Requirement                                                                                    | Enforced by                                                        | Tests                                                                                     | Status         |
| ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------- |
| R-7.0a | BET debits; rejected on insufficient funds                                                     | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.0b | WIN credits; may reference the round's BET                                                     | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.0c | LOSS records the result without moving the balance                                             | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.0d | REFUND credits, reverting a processed BET exactly once                                         | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.0e | ROLLBACK applies the inverse of a processed transaction exactly once                           | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.1  | REFUND and ROLLBACK require `referenceExternalTransactionId`                                   | `WagerTransaction.create`                                          | `test/unit/modules/wagering/domain/wager-transaction.spec.ts`                             | ✅             |
| R-7.2  | Reference resolved by `(providerId, ref)`; same provider, player, wallet, currency and round   | `WagerTransactionProcessor` (same context); lookup query (phase 3) | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | 🟡 domain done |
| R-7.3  | REFUND references only BET; ROLLBACK references BET, WIN or REFUND                             | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.4  | A reference is not reverted twice by the same kind                                             | Processor + `wager_transactions_single_reversal_idx`               | processor unit spec, `test/integration/database/wager-transactions.schema.spec.ts`        | ✅             |
| R-7.5  | Reversal amount equals the reference amount                                                    | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.6  | REJECTED changes no balance and produces no ledger entry                                       | `WagerTransactionProcessor`                                        | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts` (every rejection) | ✅             |
| R-7.7  | Replay returns the original result, including the balance observed then                        | `resultingBalance` snapshot; replay flow (phase 3)                 | `test/unit/modules/wagering/domain/wager-transaction.spec.ts`                             | 🟡 domain done |
| R-7.8  | Missing reference → `PENDING_REFERENCE`, reprocessed later                                     | Processor parks; retry worker (phase 7)                            | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | 🟡 domain done |
| R-7.9  | Reversal that would go negative is rejected with a distinct `failureCode`                      | `REVERSAL_WOULD_OVERDRAW` vs `INSUFFICIENT_FUNDS`                  | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                   | ✅             |
| R-7.10 | Scheduled worker with exponential backoff and a justified limit; exhaustion → REJECTED + event | ADR-0012, `ExponentialBackoff`; worker (phase 7)                   | `test/unit/shared/domain/exponential-backoff.spec.ts`                                     | 🟡             |
| R-7.11 | Stable, documented failure-code taxonomy                                                       | `FailureCode`, ADR-0009                                            | —                                                                                         | ✅             |

## §8 Concurrency and ordering

| ID    | Requirement                                                                                           | Enforced by                           | Tests                                                                                              | Status                         |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| R-8.1 | Mandatory scenario: 100.00, two concurrent 80.00 bets → one PROCESSED, one REJECTED, 20.00, one debit | Wallet lock (phase 3); domain outcome | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts` (sequential, domain level) | 🟡 concurrency test in phase 8 |
| R-8.2 | Several workers on the same wallet                                                                    |                                       |                                                                                                    | ⬜                             |
| R-8.3 | Different wallets processed in parallel                                                               |                                       |                                                                                                    | ⬜                             |
| R-8.4 | Three or more instances simultaneously                                                                |                                       |                                                                                                    | ⬜                             |
| R-8.5 | Strategy justified in ARCHITECTURE.md                                                                 | ADR-0007                              | —                                                                                                  | 🟡                             |

## §9 HTTP API

| ID     | Requirement                                                                         | Enforced by        | Tests                         | Status       |
| ------ | ----------------------------------------------------------------------------------- | ------------------ | ----------------------------- | ------------ |
| R-9.1  | `POST /wallets` with OPENING + CREDIT in the same transaction; duplicate → conflict |                    |                               | ⬜           |
| R-9.2  | `GET /wallets/:walletId`                                                            |                    |                               | ⬜           |
| R-9.3  | `GET /wallets/:walletId/ledger` with a stable, opaque cursor                        |                    |                               | ⬜           |
| R-9.4  | `GET /wagering/transactions/:transactionId`                                         |                    |                               | ⬜           |
| R-9.5  | `GET /providers/:providerId/wagering/transactions/:externalTransactionId`           |                    |                               | ⬜           |
| R-9.6  | `POST /wagering/transactions` requires `Idempotency-Key`                            |                    |                               | ⬜           |
| R-9.7  | `payloadHash` = hash of canonical JSON of business fields; algorithm documented     | ADR-0008           |                               | 🟡           |
| R-9.8  | Identical request → same response with `idempotentReplay: true`                     |                    |                               | ⬜           |
| R-9.9  | Same key, different payload → conflict, not replay                                  |                    |                               | ⬜           |
| R-9.10 | Distinct, consistent status codes for the five situations                           | ADR-0009           |                               | 🟡           |
| R-9.11 | Reconciliation endpoint; divergences logged, metered, flagged, never corrected      | ADR-0013           |                               | ⬜           |
| R-9.12 | `GET /health/live` and `GET /health/ready`                                          | `HealthController` | `test/e2e/health.e2e.spec.ts` | 🟡 live only |

## §10 SQS processing

| ID     | Requirement                                                        | Enforced by                                    | Tests          | Status            |
| ------ | ------------------------------------------------------------------ | ---------------------------------------------- | -------------- | ----------------- |
| R-10.1 | Queues `wager-transactions.fifo` and `wager-transactions-dlq.fifo` | `scripts/sqs-bootstrap.ts`                     | contract suite | 🟡 queues created |
| R-10.2 | Consumer reuses the HTTP use case                                  |                                                |                | ⬜                |
| R-10.3 | Persistent inbox deduplication by `(consumerName, messageId)`      |                                                |                | ⬜                |
| R-10.4 | Ack only after commit                                              |                                                |                | ⬜                |
| R-10.5 | Business (ack), transient (retry with backoff), permanent (DLQ)    |                                                |                | ⬜                |
| R-10.6 | Attempt limit before the DLQ                                       | `scripts/sqs-bootstrap.ts` (maxReceiveCount 5) |                | 🟡                |
| R-10.7 | SIGTERM: finish in-flight or release visibility                    |                                                |                | ⬜                |
| R-10.8 | Redelivery without duplicated effects                              |                                                |                | ⬜                |

## §11 Transactional outbox

| ID     | Requirement                                                                           | Enforced by                                      | Tests                                                                                                                                  | Status                 |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| R-11.1 | Transaction, balance, ledger, inbox and event are atomic                              |                                                  |                                                                                                                                        | ⬜                     |
| R-11.2 | Works with several concurrent publishers                                              |                                                  |                                                                                                                                        | ⬜                     |
| R-11.3 | Commit → crash before publish → another instance publishes; duplicate publish is safe |                                                  |                                                                                                                                        | ⬜                     |
| R-11.4 | Events: Processed, Rejected, BalanceChanged (only on change), PendingReference        | Event classes in `wallet` and `wagering` domains | `test/unit/modules/wagering/domain/wager-transaction-events.spec.ts`, `test/unit/modules/wallet/domain/wallet-balance-changed.spec.ts` | 🟡 emission in phase 3 |
| R-11.5 | Abstract envelope class, one subclass per event; `data` carries `MoneyProps`          | `IntegrationEvent` + one subclass per event      | `test/unit/shared/domain/integration-event.spec.ts`                                                                                    | ✅                     |

## §12 Observability

| ID     | Requirement                                                                    | Enforced by | Tests | Status |
| ------ | ------------------------------------------------------------------------------ | ----------- | ----- | ------ |
| R-12.1 | JSON logs with correlationId, messageId, transactionId, walletId, providerId   |             |       | ⬜     |
| R-12.2 | No sensitive data or full financial payloads in logs                           |             |       | ⬜     |
| R-12.3 | Metrics: status, duplicates, retries, DLQ, lock conflicts, outbox lag, latency |             |       | ⬜     |
| R-12.4 | Separate liveness and readiness                                                |             |       | 🟡     |

## §13 Mandatory tests

| ID    | Requirement                                                              | Tests                                                                                                           | Status |
| ----- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------ |
| T-U1  | Money operations and validation (scale, rounding, invalid inputs)        | `test/unit/shared/domain/money.spec.ts`                                                                         | ✅     |
| T-U2  | Wallet invariants                                                        | `test/unit/modules/wallet/domain/wallet.spec.ts`, `test/unit/modules/wallet/domain/wallet-ledger-entry.spec.ts` | ✅     |
| T-U3  | BET, WIN, LOSS, REFUND, ROLLBACK rules                                   | `test/unit/modules/wagering/domain/wager-transaction-processor.spec.ts`                                         | ✅     |
| T-U4  | Currency conflict                                                        | `test/unit/shared/domain/money.spec.ts`, wallet and processor specs                                             | ✅     |
| T-U5  | Idempotency key with a divergent payload                                 | `test/unit/modules/wagering/domain/wager-payload.spec.ts`; use-case conflict test (phase 3)                     | 🟡     |
| T-I1  | Migrations and constraints                                               | `test/integration/database/migrations.spec.ts`, `test/integration/database/*.schema.spec.ts`                    | ✅     |
| T-I2  | Atomicity across wallet, ledger, inbox and outbox                        |                                                                                                                 | ⬜     |
| T-I3  | Inbox and redelivery                                                     |                                                                                                                 | ⬜     |
| T-I4  | Concurrent publishers on the same outbox                                 |                                                                                                                 | ⬜     |
| T-I5  | Retry and DLQ                                                            |                                                                                                                 | ⬜     |
| T-I6  | Recovery after restart                                                   |                                                                                                                 | ⬜     |
| T-C1  | Same bet sent 50 times in parallel → one debit                           |                                                                                                                 | ⬜     |
| T-C2  | Concurrent operations competing for one wallet (§8 scenario)             |                                                                                                                 | ⬜     |
| T-C3  | Different wallets in parallel                                            |                                                                                                                 | ⬜     |
| T-C4  | ≥ 3 processes / instances                                                |                                                                                                                 | ⬜     |
| T-C5  | Worker killed after commit and before ack                                |                                                                                                                 | ⬜     |
| T-C6  | Two publishers on the same outbox                                        |                                                                                                                 | ⬜     |
| T-C7  | ROLLBACK or REFUND delivered before its reference                        |                                                                                                                 | ⬜     |
| T-C8  | Service restart with proof of final consistency                          |                                                                                                                 | ⬜     |
| T-INV | Every test ends with `wallet.balance == balance rebuilt from the ledger` |                                                                                                                 | ⬜     |

## §14 Documentation and eliminatory failures

| ID  | Requirement                                                  | Evidence                                                           | Status |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ------ |
| D-1 | `README.md` with setup and commands                          | `README.md`                                                        | 🟡     |
| D-2 | `ARCHITECTURE.md` with decisions, trade-offs and limitations | `ARCHITECTURE.md`, `docs/adr/`                                     | 🟡     |
| E-1 | No `number` for money                                        | `Money` (`bigint`), `money_amount` domain (no float, no rounding)  | ✅     |
| E-2 | No negative balance caused by a race                         |                                                                    | ⬜     |
| E-3 | No duplicated debit or credit                                |                                                                    | ⬜     |
| E-4 | Idempotency not only in memory                               |                                                                    | ⬜     |
| E-5 | Correct with more than one instance                          |                                                                    | ⬜     |
| E-6 | No event published before commit                             |                                                                    | ⬜     |
| E-7 | Auditable ledger present                                     | Append-only, chained ledger enforced by the schema; API in phase 4 | 🟡     |
| E-8 | PostgreSQL and SQS not replaced entirely by mocks in tests   | ADR-0017, integration suites                                       | 🟡     |
| O-1 | (Optional) Load test via `bun run test:load`                 |                                                                    | ⬜     |
