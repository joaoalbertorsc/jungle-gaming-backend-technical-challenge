import type {
  ApplicationLogger,
  ApplicationMetrics,
  Clock,
  FaultInjector,
  FaultPoint,
  IdGenerator,
} from '../../shared/application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Time-ordered UUID v7, like the ids in the challenge examples (ADR-0003). */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/** Exit code of a process ended by `CrashAt`, so tests can tell the injected crash from a bug. */
export const FAULT_CRASH_EXIT_CODE = 86;

/**
 * Test-only (ADR-0017, enabled by FAULT_CRASH_AT under NODE_ENV=test): ends the process the moment it
 * reaches `point`, synchronously, so nothing after it runs: no ack, no publication mark, no shutdown
 * hook. From the outside this is indistinguishable from a killed container.
 */
export class CrashAt implements FaultInjector {
  constructor(
    private readonly point: FaultPoint,
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {}

  hit(point: FaultPoint): void {
    if (point === this.point) this.exit(FAULT_CRASH_EXIT_CODE);
  }
}

/** Production fault injector: never fails. */
export class NoFaults implements FaultInjector {
  hit(): void {
    // Intentionally empty: faults exist only in tests.
  }
}

/** Placeholder until the Prometheus adapter lands (phase 9). */
export class NoopMetrics implements ApplicationMetrics {
  transactionOutcome(): void {
    // no-op
  }
  idempotentReplay(): void {
    // no-op
  }
  lockConflict(): void {
    // no-op
  }
  reconciliationMismatch(): void {
    // no-op
  }
  duplicateMessage(): void {
    // no-op
  }
  messageRetried(): void {
    // no-op
  }
  deadLettered(): void {
    // no-op
  }
  outboxPublished(): void {
    // no-op
  }
  outboxFailed(): void {
    // no-op
  }
  referenceRetry(): void {
    // no-op
  }
}

/** Minimal structured logger until pino lands (phase 9): one JSON line per entry. */
export class JsonConsoleLogger implements ApplicationLogger {
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: string, message: string, fields?: Record<string, unknown>): void {
    console.log(JSON.stringify({ level, time: new Date().toISOString(), message, ...fields }));
  }
}
