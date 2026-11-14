/** Time source; deterministic in tests. */
export interface Clock {
  now(): Date;
}

/** Id source (UUID v7 in production, ADR-0003). */
export interface IdGenerator {
  next(): string;
}

/**
 * Named points where tests can inject a failure (e.g. a crash just before commit). Production uses
 * a no-op implementation; nothing outside tests can trigger a fault (ADR-0017).
 */
export const FAULT_POINTS = [
  'wager.before-commit',
  'wallet.before-commit',
  'consumer.before-ack',
  'outbox.before-publish',
  'outbox.after-publish',
  'pending-reference.before-commit',
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultInjector {
  hit(point: FaultPoint): void;
}

/** Correlation data carried from the transport into use cases and events. */
export interface RequestContext {
  readonly correlationId: string;
  /** What caused this request: the SQS messageId, or nothing for HTTP. */
  readonly causationId?: string | undefined;
  readonly channel: 'http' | 'sqs' | 'worker';
}

export interface ApplicationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Business metrics (§12). The Prometheus adapter lands with observability (phase 9). */
export interface ApplicationMetrics {
  transactionOutcome(kind: string, status: string, channel: string): void;
  idempotentReplay(channel: string): void;
  lockConflict(): void;
  reconciliationMismatch(): void;
  /** A message already recorded in the inbox arrived again. */
  duplicateMessage(consumer: string): void;
  /** A message was left for redelivery after a transient failure. */
  messageRetried(reason: string): void;
  /** A message was moved to the dead-letter queue. */
  deadLettered(reason: string): void;
  outboxPublished(eventType: string): void;
  /** A publication attempt failed and was rescheduled. */
  outboxFailed(): void;
  /** A PENDING_REFERENCE retry ended: processed, rejected or rescheduled (ADR-0012). */
  referenceRetry(result: string): void;
}

export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const FAULT_INJECTOR = Symbol('FAULT_INJECTOR');
export const APPLICATION_LOGGER = Symbol('APPLICATION_LOGGER');
export const APPLICATION_METRICS = Symbol('APPLICATION_METRICS');
