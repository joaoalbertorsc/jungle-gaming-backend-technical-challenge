# Architecture

> Living document. It summarizes the design and links to the decision records in [`docs/adr/`](docs/adr/).
> Sections marked _(phase N)_ are completed as those phases land.

## 1. Overview

A distributed wallet and wagering processor. Game providers submit `BET → WIN | LOSS | REFUND | ROLLBACK`
operations over HTTP or SQS. Delivery is at-least-once, so the system must stay correct under duplicated,
out-of-order and concurrent messages, across several instances.

The design rests on four ideas:

1. **One SQL transaction per operation.** The transaction outcome, balance change, ledger entry, inbox record
   and outbox events commit together or not at all (ADR-0001, ADR-0004).
2. **The database owns the invariants.** Uniqueness, non-negativity and ledger immutability are constraints
   and triggers, not just code (ADR-0006).
3. **The wallet is the unit of concurrency.** A row lock per wallet serializes competing operations. There is
   no global lock (ADR-0007).
4. **Idempotency is persistent.** The key and payload hash are stored with the transaction outcome, and the
   SQS inbox is a table (ADR-0008, ADR-0010).

## 2. Runtime topology

One image, several roles (`api`, `consumer`, `outbox-relay`, `retry-worker`), each horizontally scalable,
sharing one PostgreSQL. See [`docs/diagrams/runtime-topology.md`](docs/diagrams/runtime-topology.md).

## 3. Code structure

Hexagonal modules (`domain → application → infrastructure / interface`) with a framework-free domain.
See [`docs/diagrams/module-structure.md`](docs/diagrams/module-structure.md) and ADR-0003.

## 4. Key decisions

| Topic                      | Decision                                                                     | ADR                                                        |
| -------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Deployment shape           | Modular monolith, one image, role per process                                | [0001](docs/adr/0001-modular-monolith.md)                  |
| Toolchain                  | Bun 1.4, TS 6 strict, NestJS 12, container-only workflow                     | [0002](docs/adr/0002-runtime-and-toolchain.md)             |
| ORM and migrations         | MikroORM 7; hand-written SQL migrations with up/down                         | [0004](docs/adr/0004-persistence-and-migrations.md)        |
| Money                      | `bigint` minor units, strict decimal-string parsing, no rounding             | [0005](docs/adr/0005-money.md)                             |
| Schema guarantees          | Constraints, partial indexes, immutability triggers, two DB roles            | [0006](docs/adr/0006-schema-level-guarantees.md)           |
| Concurrency                | `SELECT ... FOR UPDATE` on the wallet, `lock_timeout`, version check         | [0007](docs/adr/0007-concurrency-control.md)               |
| Idempotency                | Unique key + SHA-256 of canonical JSON, stored outcome for replay            | [0008](docs/adr/0008-idempotency.md)                       |
| Errors and HTTP            | Outcomes vs exceptions, failure codes, Problem Details, global filter        | [0009](docs/adr/0009-errors-and-http-contract.md)          |
| SQS consumer               | Inbox in the same transaction, ack after commit, error classes, DLQ          | [0010](docs/adr/0010-sqs-consumer.md)                      |
| Outbox                     | `SKIP LOCKED` claims with lease, at-least-once, consumers dedup by `eventId` | [0011](docs/adr/0011-transactional-outbox.md)              |
| Out-of-order references    | `PENDING_REFERENCE` + retry worker, 10 attempts with backoff                 | [0012](docs/adr/0012-pending-references.md)                |
| Queries and reconciliation | Keyset cursor; snapshot reconciliation that never writes                     | [0013](docs/adr/0013-ledger-queries-and-reconciliation.md) |
| Authentication             | Deferred behind a guard and port; Keycloak design documented                 | [0014](docs/adr/0014-authentication.md)                    |
| Observability              | pino JSON, correlation via AsyncLocalStorage, Prometheus metrics             | [0015](docs/adr/0015-observability.md)                     |
| SQS emulator               | MiniStack (no auth token), proven by a contract suite                        | [0016](docs/adr/0016-sqs-emulator.md)                      |
| Testing                    | TDD; real Postgres + SQS; ≥ 3 processes; ledger invariant on every test      | [0017](docs/adr/0017-testing-strategy.md)                  |

## 5. Data model _(phase 2)_

## 6. Main flows _(phases 3–7)_

- Submit a wager over HTTP
- Consume a wager from SQS
- Publish outbox events
- Resolve a pending reference

## 7. Failure handling _(phases 4–7)_

## 8. Trade-offs and limitations

- **Single database.** It is the consistency anchor and also the scaling ceiling. That is acceptable at this
  scope; sharding by wallet would be the next step.
- **Per-wallet serialization.** A very hot wallet is bounded by transaction latency. The trade buys
  determinism under contention.
- **MiniStack instead of real SQS.** Fidelity is covered by the emulator contract suite, but production
  behaviour (e.g. throttling) is not.
- **Authentication deferred.** The extension point exists; the IdP integration is optional (ADR-0014).
- **Required checks not enforced on GitHub Free private repositories.** "Merge only on green" is a process
  rule until the repository is public (ADR-0018).
