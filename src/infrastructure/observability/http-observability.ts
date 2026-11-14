import type { ApplicationLogger } from '../../shared/application/ports';
import type { PrometheusMetrics } from './prometheus-metrics';

interface ObservedRequest {
  method?: string;
  originalUrl?: string;
  correlationId?: string;
  route?: { path?: string };
}

interface ObservedResponse {
  statusCode: number;
  once(event: 'finish', listener: () => void): unknown;
}

/** Probes, scrapes and documentation assets are measured but not logged. */
const QUIET_PATHS = /^\/(health\/|metrics(\/|\?|$)|docs(\/|$)|openapi\.)/;

/**
 * One JSON access-log line and one latency observation per HTTP request. The label is the route
 * template (`/wallets/:walletId`), never the concrete path, so ids do not explode the series.
 */
export function httpObservability(logger: ApplicationLogger, metrics: PrometheusMetrics) {
  return (request: ObservedRequest, response: ObservedResponse, next: () => void): void => {
    const started = performance.now();
    response.once('finish', () => {
      const elapsedMs = performance.now() - started;
      const method = request.method ?? 'UNKNOWN';
      const route = request.route?.path ?? 'unmatched';
      metrics.httpRequest(method, route, response.statusCode, elapsedMs / 1_000);
      if (QUIET_PATHS.test(request.originalUrl ?? '')) return;
      logger.info('http request', {
        correlationId: request.correlationId,
        method,
        route,
        status: response.statusCode,
        durationMs: Math.round(elapsedMs * 100) / 100,
      });
    });
    next();
  };
}
