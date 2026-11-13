# Architecture Decision Records

Each ADR records one architectural decision: its context, the decision, and its consequences.
They were agreed during planning (2026-11-12) and are updated when a later phase changes them.
The `#NN` numbers map to the original planning decision log.

| ADR                                               | Title                                                        | Status   | Planning decisions      |
| ------------------------------------------------- | ------------------------------------------------------------ | -------- | ----------------------- |
| [0001](0001-modular-monolith.md)                  | Modular monolith deployed as multiple processes              | Accepted | #01                     |
| [0002](0002-runtime-and-toolchain.md)             | Runtime, language and container-only toolchain               | Accepted | #02, #03                |
| [0003](0003-hexagonal-modules.md)                 | Hexagonal modules and the dependency rule                    | Accepted | #04, #05                |
| [0004](0004-persistence-and-migrations.md)        | MikroORM persistence and SQL-first reversible migrations     | Accepted | #06, #07, #08           |
| [0005](0005-money.md)                             | Money as an exact, immutable value object                    | Accepted | #09                     |
| [0006](0006-schema-level-guarantees.md)           | Invariants enforced by the database schema                   | Accepted | #10, #11, #12           |
| [0007](0007-concurrency-control.md)               | Pessimistic row lock per wallet                              | Accepted | #13                     |
| [0008](0008-idempotency.md)                       | Persistent idempotency and replay                            | Accepted | #14, #15                |
| [0009](0009-errors-and-http-contract.md)          | Business outcomes, failure codes and the HTTP error contract | Accepted | #16, #17, #25, #26, #27 |
| [0010](0010-sqs-consumer.md)                      | SQS consumer with persistent inbox                           | Accepted | #18, #19, #20, #21      |
| [0011](0011-transactional-outbox.md)              | Transactional outbox and integration events                  | Accepted | #22, #23                |
| [0012](0012-pending-references.md)                | Out-of-order references (PENDING_REFERENCE)                  | Accepted | #24                     |
| [0013](0013-ledger-queries-and-reconciliation.md) | Ledger pagination and reconciliation                         | Accepted | #28, #29                |
| [0014](0014-authentication.md)                    | Authentication deferred behind an extension point            | Accepted | #30                     |
| [0015](0015-observability.md)                     | Structured logs, metrics and health checks                   | Accepted | #31, #32, #33           |
| [0016](0016-sqs-emulator.md)                      | MiniStack as the local SQS emulator                          | Accepted | #40                     |
| [0017](0017-testing-strategy.md)                  | TDD and the testing strategy                                 | Accepted | #34, #35, #36, #37, #41 |
| [0018](0018-delivery-workflow.md)                 | Documentation, git workflow and CI                           | Accepted | #38, #39, #42           |

## Template

```md
# ADR-NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD

## Context

## Decision

## Consequences

## Alternatives considered
```
