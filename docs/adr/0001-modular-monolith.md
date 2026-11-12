# ADR-0001: Modular monolith deployed as multiple processes

- Status: Accepted
- Date: 2026-11-12

## Context

The challenge requires the inbox record, the transaction, the balance change, the ledger entry and the
outbox event to be committed **atomically, in one SQL transaction** (§6.5, §11). It also requires
correctness with **three or more instances** running at once (§5.8, §8).

Splitting wallet and wagering into separately deployed services, each with its own database, would turn
that single atomic unit into a distributed transaction (saga or two-phase commit). That adds failure modes
without adding any guarantee the challenge asks for, and simplicity is part of the evaluation.

## Decision

- One NestJS codebase and one PostgreSQL database, organized in bounded-context modules:
  `wallet`, `wagering`, `messaging` (inbox/outbox), `reconciliation` and `health`.
- The same container image runs in different **roles**, selected by `APP_ROLES`:
  - `api`: HTTP API;
  - `consumer`: SQS consumer for `wager-transactions.fifo`;
  - `outbox-relay`: publishes pending outbox events;
  - `retry-worker`: reprocesses `PENDING_REFERENCE` transactions.
- Every role scales horizontally. The concurrency suite runs at least three replicas.
- Processes coordinate **only** through PostgreSQL (row locks, `SKIP LOCKED` claims, unique constraints)
  and SQS. Correctness never depends on in-memory state.
- One-shot services `migrate` and `sqs-init` prepare the schema and the queues before the roles start.

## Consequences

- Atomicity is a plain local SQL transaction.
- One image and one migration history.
- Roles scale and fail independently. A crashed relay or consumer is replaced by any other instance.
- Modules share a database, so their boundaries are enforced by code structure (ADR-0003), not by the network.
- Extracting a module later would integrate through the outbox events that already exist.

## Alternatives considered

- **Microservices per bounded context.** Rejected: a single bet would need a distributed transaction.
- **A single process running every role.** Still possible for local runs (`APP_ROLES=api,consumer,...`),
  but on its own it does not demonstrate multi-instance correctness.
