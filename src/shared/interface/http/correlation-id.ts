import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelatedRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface HeaderWriter {
  setHeader(name: string, value: string): unknown;
}

/**
 * Accepts the caller's X-Correlation-Id when it is safe to log, or mints a UUID v7, then echoes it
 * on the response. Every log line, event and Problem Details body carries it (ADR-0015).
 */
export function correlationIdMiddleware(
  request: CorrelatedRequest,
  response: HeaderWriter,
  next: () => void,
): void {
  const header = request.headers[CORRELATION_HEADER];
  const correlationId =
    typeof header === 'string' && SAFE_CORRELATION_ID.test(header) ? header : Bun.randomUUIDv7();
  request.correlationId = correlationId;
  response.setHeader(CORRELATION_HEADER, correlationId);
  next();
}

export function correlationIdOf(request: CorrelatedRequest): string {
  return request.correlationId ?? Bun.randomUUIDv7();
}

/** Controller parameter: the request's correlation id. */
export const CorrelationId = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  correlationIdOf(context.switchToHttp().getRequest<CorrelatedRequest>()),
);
