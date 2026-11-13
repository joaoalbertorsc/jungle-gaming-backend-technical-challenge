# ADR-0003: Hexagonal modules and the dependency rule

- Status: Accepted
- Date: 2026-11-12

## Context

Modeling and architecture are evaluated on "invariants encapsulated in classes, boundaries, ports,
simplicity" (§14). The domain must not depend on ORM monetary types or NestJS decorators (§6.1).

## Decision

Every business module (`src/modules/<module>/`) has four layers:

| Layer            | Contains                                                                                         | May depend on           |
| ---------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| `domain`         | Aggregates, value objects, domain errors, integration event classes. Plain TypeScript.           | shared kernel only      |
| `application`    | Use cases and **ports** (repositories, transaction runner, event publisher, clock, id generator) | `domain`                |
| `infrastructure` | Adapters: MikroORM repositories and mappers, SQS clients                                         | `application`, `domain` |
| `interface`      | HTTP controllers, SQS handlers, workers, request/response schemas                                | `application`           |

- `src/shared` is the shared kernel: `Money`, base error types, and the `Clock` and `IdGenerator` ports.
- `src/infrastructure` holds cross-cutting adapters: database configuration and migrations, the SQS client,
  observability.
- **Clock and IdGenerator are ports.** Production uses the system clock and UUID v7
  (`Bun.randomUUIDv7()`, which matches the challenge examples). Unit tests use deterministic fakes.
- The dependency rule (domain depends on nothing; interface never touches infrastructure) is checked by an
  automated test from phase 1 onward.

## Consequences

- Domain rules are unit-tested without NestJS, a database or a queue.
- HTTP and SQS reuse the **same** use case (§10), because both live in the interface layer.
- There is more mapping code (persistence model ↔ domain). That is the price of a framework-free domain.

## Alternatives considered

- **NestJS services with ORM entities as the domain.** Rejected: it couples invariants to decorators and the
  ORM's lifecycle, which goes against §6.0 and §6.1.
