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
export type FaultPoint = 'wager.before-commit' | 'wallet.before-commit';

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
}

export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const FAULT_INJECTOR = Symbol('FAULT_INJECTOR');
export const APPLICATION_LOGGER = Symbol('APPLICATION_LOGGER');
export const APPLICATION_METRICS = Symbol('APPLICATION_METRICS');
