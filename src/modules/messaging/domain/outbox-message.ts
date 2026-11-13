import { ExponentialBackoff } from '../../../shared/domain/exponential-backoff';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';
import { InvalidMessageStateError } from './messaging-errors';

/** 1 s doubling up to 5 min between publish attempts (ADR-0011). */
export const DEFAULT_OUTBOX_BACKOFF = new ExponentialBackoff({
  baseMs: 1_000,
  factor: 2,
  maxMs: 300_000,
});

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly publishedAt?: Date | undefined;
}

/**
 * An integration event waiting to be published, written in the same SQL transaction as the change
 * that produced it (§11). The relay publishes it at least once; consumers deduplicate by eventId.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** Due immediately: the first attempt happens as soon as a relay claims it. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
    });
  }

  /** Reconstruction from persistence: no validation (§6.0). */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt.getTime()),
      state.attempts,
      copyDate(state.nextAttemptAt),
      copyDate(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return copyDate(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return copyDate(this._publishedAt);
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = new Date(at.getTime());
  }

  /** Counts a failed attempt and pushes the next one out with exponential backoff. */
  scheduleRetry(now: Date, backoff: ExponentialBackoff = DEFAULT_OUTBOX_BACKOFF): void {
    this.assertPending('scheduleRetry');
    this._attempts += 1;
    this._nextAttemptAt = backoff.nextAttemptAt(now, this._attempts);
  }

  private assertPending(transition: string): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(this.id, `${transition} on an already published message`);
    }
  }
}

function copyDate(date: Date | undefined): Date | undefined {
  return date === undefined ? undefined : new Date(date.getTime());
}
