import type { AppConfig } from '../../../config/load-config';
import { ExponentialBackoff } from '../../../shared/domain/exponential-backoff';
import { ReferenceRetryPolicy } from '../domain/reference-retry-policy';

/** The configured retry schedule, shared by the arrival (first retry) and the worker (ADR-0012). */
export function referenceRetryPolicy(settings: AppConfig['referenceRetry']): ReferenceRetryPolicy {
  return new ReferenceRetryPolicy({
    maxAttempts: settings.maxAttempts,
    backoff: new ExponentialBackoff({ baseMs: settings.baseMs, factor: 2, maxMs: settings.maxMs }),
  });
}
