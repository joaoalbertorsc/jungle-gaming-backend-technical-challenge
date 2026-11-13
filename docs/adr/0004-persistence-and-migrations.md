# ADR-0004: MikroORM persistence and SQL-first reversible migrations

- Status: Accepted
- Date: 2026-11-12

## Context

The ORM must be MikroORM (preferred) or TypeORM, and the choice, the mapping of `Money` and the transactional
strategy must be justified (§4). Migrations must be versioned and **reversible**. The schema itself is
evaluated (§5.9): constraints, partial indexes and triggers are central.

## Decision

- **MikroORM 7.** Its Unit of Work and Identity Map are explicit, `em.transactional()` gives a clear
  transaction boundary, and `LockMode.PESSIMISTIC_WRITE` provides the per-wallet row lock (ADR-0007).
  A phase 0 spike (`test/integration/infrastructure/mikro-orm-migrator.spike.spec.ts`) proved v7 on Bun.
- **Domain classes are not ORM entities.** Infrastructure defines persistence models and mappers. Mappers
  rebuild domain objects through their `rehydrate` factories, which by design do not re-validate transitions
  (§6.0), and copy state changes back.
- **Transaction strategy.** Each use case runs inside a transaction-runner port, implemented with
  `em.transactional()` on a forked `EntityManager`. Every repository call made in that use case shares that
  transaction: inbox, transaction, wallet, ledger and outbox all commit or roll back together.
- **Money mapping.** A `money_amount` domain (`NUMERIC` checked for >= 0, at most 2 decimals and 17 integer
  digits) plus a `currency_code` domain (`CHAR(3)`, ISO-4217). A `NUMERIC(19,2)` typmod was rejected because it
  silently rounds `1.005` to `1.01`. PostgreSQL returns `NUMERIC` as a string, and the
  mapper turns it into `Money` (ADR-0005). No floating point anywhere in the path.
- **Migrations.**
  - MikroORM Migrator with **hand-written SQL** (`this.addSql(...)`) and explicit `up()` and `down()` in every file.
  - Each migration is transactional and the run is all-or-nothing. Schema snapshots are disabled. The history
    table is `schema_migrations`.
  - They run in the one-shot `migrate` service with the schema-owner role (`bun run migration:up|down|pending`).

## Consequences

- Migrations read like plain SQL and are reversible by construction. CI applies them against a real database.
- Schema changes are never generated from entities. Each one is reviewed as SQL.

## Alternatives considered

- **Flyway.** Language-agnostic and SQL-first, but its `undo` is only available in the paid editions. The
  Community edition can only add forward "compensating" migrations, which fails the reversibility requirement.
  It would also add a second tool that owns the schema.
- **TypeORM.** Accepted by the challenge, but MikroORM's explicit Unit of Work fits the design better.
- **Schema generation from entities.** Rejected: constraints, triggers and partial indexes are clearer and
  safer as reviewed SQL.
