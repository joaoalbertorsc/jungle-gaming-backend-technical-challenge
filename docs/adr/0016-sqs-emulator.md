# ADR-0016: MiniStack as the local SQS emulator

- Status: Accepted
- Date: 2026-11-12

## Context

SQS runs through LocalStack or MiniStack (§4). Since its 2026.03 release, **LocalStack requires an auth token
to start**, even on the free plan. A reviewer running `docker compose up` would need to sign up first, and so
would CI.

## Decision

- **Default emulator.** MiniStack `1.5.40` (MIT licence, no token), exposed on port 4566.
- **Proof.** The choice is backed by a contract suite (`test/integration/infrastructure/sqs-emulator.contract.spec.ts`)
  covering every SQS behaviour the consumer and the relay depend on:
  - FIFO queue with a redrive policy pointing at its DLQ;
  - deduplication by `MessageDeduplicationId`;
  - delivery in send order within a message group;
  - in-flight messages hidden, and redelivered after `ChangeMessageVisibility(0)`, with `ApproximateReceiveCount`
    incrementing;
  - `DeleteMessage` working as an ack;
  - dead-lettering after `maxReceiveCount` receives.
- **Result.** The whole suite passed in phase 0.
- **Coupling.** The application only knows `SQS_ENDPOINT`, `AWS_REGION` and the queue names.

## Consequences

- Reviewers and CI run the full stack with zero sign-ups.
- Switching to LocalStack means changing the image, adding `LOCALSTACK_AUTH_TOKEN`, and passing the contract
  suite again.

## Alternatives considered

- **LocalStack.** Well known, but now needs an account and token for every environment.
- **Floci and other emulators.** Not listed by the challenge.
