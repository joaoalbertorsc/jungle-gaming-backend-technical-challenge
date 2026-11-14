import type { LoggerService } from '@nestjs/common';
import type { LogLevel } from '../../config/load-config';
import type { ApplicationLogger } from '../../shared/application/ports';

const SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * Keys whose values never reach a log line (§12): credentials, and whole request or message
 * payloads, which would carry the financial details. Identifiers and outcomes stay.
 */
const REDACTED_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'payload',
  'body',
  'money',
]);
const MAX_DEPTH = 6;

export interface JsonLoggerOptions {
  /** Entries below this level are dropped. */
  readonly level?: LogLevel | undefined;
  readonly write?: (line: string) => void;
}

/** Structured logs: one JSON object per line on stdout (§12, ADR-0015). */
export class JsonLogger implements ApplicationLogger {
  private readonly threshold: number;
  private readonly writeLine: (line: string) => void;

  constructor(options: JsonLoggerOptions = {}) {
    this.threshold = SEVERITY[options.level ?? 'info'];
    this.writeLine =
      options.write ??
      ((line) => {
        console.log(line);
      });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  write(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    if (SEVERITY[level] < this.threshold) return;
    const safe = sanitize(fields, 0) as Record<string, unknown>;
    this.writeLine(JSON.stringify({ level, time: new Date().toISOString(), message, ...safe }));
  }
}

function sanitize(value: unknown, depth: number): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitize(item, depth + 1),
    ]),
  );
}

/** Nest's own logs (bootstrap, router, exceptions) as the same JSON lines. */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: JsonLogger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.write('info', String(message), contextOf(optional));
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.write('warn', String(message), contextOf(optional));
  }
  error(message: unknown, ...optional: unknown[]): void {
    this.logger.write('error', String(message), contextOf(optional));
  }
  fatal(message: unknown, ...optional: unknown[]): void {
    this.logger.write('error', String(message), contextOf(optional));
  }
  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.write('debug', String(message), contextOf(optional));
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.write('debug', String(message), contextOf(optional));
  }
}

/** Nest passes the context (the class name) as the last argument. Stacks are not logged. */
function contextOf(optional: readonly unknown[]): Record<string, unknown> {
  const context = optional.at(-1);
  return typeof context === 'string' ? { context } : {};
}
