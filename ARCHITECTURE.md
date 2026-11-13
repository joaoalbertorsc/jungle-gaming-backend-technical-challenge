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

## 5. Domain model

All domain classes are plain TypeScript (no NestJS, ORM or SDK imports; enforced by
`test/unit/architecture/dependency-rule.spec.ts`). Constructors are private: `create`/`open`/`enqueue`
validate, and `rehydrate` rebuilds persisted state without re-validating (§6.0).

| Class                            | Module    | Responsibility                                                                    |
| -------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `Money`                          | shared    | Exact `bigint` minor units, strict decimal-string contract, currency-checked math |
| `IntegrationEvent`               | shared    | Abstract envelope; subclasses fix `eventType` and `version`                       |
| `Wallet`                         | wallet    | Balance, version, the only source of ledger entries                               |
| `WalletLedgerEntry`              | wallet    | Frozen ledger line; `create` validates its arithmetic                             |
| `WagerTransaction`               | wagering  | Per-kind creation rules, state machine, payload hash, replay snapshot             |
| `WagerTransactionProcessor`      | wagering  | Stateless domain service applying §7 against a locked wallet                      |
| `InboxMessage` / `OutboxMessage` | messaging | Persistent dedup record; publishable event with retry backoff                     |

The state machine, the processor's decision order and the rules per kind are drawn in
[`docs/diagrams/wager-transaction-states.md`](docs/diagrams/wager-transaction-states.md).

### Documented interpretations

The challenge leaves room for interpretation in a few places (§7 asks for them to be documented):

1. **One reversal per reference, in total.** §7 rule 4 forbids reverting a reference twice _by the same kind_.
   Taken literally, a BET could be refunded **and** rolled back, crediting it twice. That violates "no
   duplicated credits" (§3). A reference is therefore reversed at most once, by a REFUND or a ROLLBACK. A
   ROLLBACK of a REFUND is still allowed, because it reverses the REFUND, not the BET.
2. **WIN and LOSS may reference the round BET.** When they do, the reference is validated like any other
   (same context, kind BET, processed). The amount does not have to match.
3. **A reference that exists but is undecided** (`PENDING` / `PENDING_REFERENCE`) makes the dependent
   transaction wait, exactly like a missing one. A reference that ended `REJECTED` / `FAILED` is final:
   `REFERENCE_NOT_PROCESSED`.
4. **Zero amounts** are accepted only for LOSS. Every balance-moving kind requires a positive amount.
5. **Money input** accepts 0 to 2 decimals (`25`, `25.5`, `25.00`) and always serializes with 2. More
   decimals are rejected, never rounded. Amounts have at most 17 integer digits, to fit `NUMERIC(19,2)`.
6. **Provider id `internal` is reserved** for the OPENING transaction, so external submissions cannot use it.
7. **Ledger entries carry the wallet version** they produced. That version is gap-free per wallet, starts at 1,
   and backs the proposed version-chain constraint and a stable ledger cursor (ADR-0006, ADR-0013).

## 6. Data model _(phase 2)_

## 7. Main flows _(phases 3–7)_

- Submit a wager over HTTP
- Consume a wager from SQS
- Publish outbox events
- Resolve a pending reference

## 8. Failure handling _(phases 4–7)_

## 9. Trade-offs and limitations

- **Single database.** It is the consistency anchor and also the scaling ceiling. That is acceptable at this
  scope; sharding by wallet would be the next step.
- **Per-wallet serialization.** A very hot wallet is bounded by transaction latency. The trade buys
  determinism under contention.
- **MiniStack instead of real SQS.** Fidelity is covered by the emulator contract suite, but production
  behaviour (e.g. throttling) is not.
- **Authentication deferred.** The extension point exists; the IdP integration is optional (ADR-0014).
- **Required checks not enforced on GitHub Free private repositories.** "Merge only on green" is a process
  rule until the repository is public (ADR-0018).
