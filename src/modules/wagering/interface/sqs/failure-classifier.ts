import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  UnknownWalletError,
} from '../../../../shared/application/application-errors';
import { InvalidMoneyError } from '../../../../shared/domain/errors';
import { InvalidWagerTransactionError } from '../../domain/wagering-errors';

export type Disposition =
  /** Terminal business outcome: delete the message. */
  | { readonly action: 'ack'; readonly reason: string }
  /** Permanent: retrying cannot help. Move to the DLQ with a reason, then delete. */
  | { readonly action: 'dead-letter'; readonly reason: string }
  /** Transient: keep the message and let it come back after a backoff (redrive caps attempts). */
  | { readonly action: 'retry'; readonly reason: string };

/**
 * The SQS side of the error taxonomy (ADR-0009, ADR-0010). The same errors the HTTP filter maps to
 * 400/409/422/503 map here to dead-letter, ack or retry.
 */
export function classifyFailure(error: unknown): Disposition {
  if (error instanceof InvalidWagerTransactionError || error instanceof InvalidMoneyError) {
    return { action: 'dead-letter', reason: 'INVALID_MESSAGE' };
  }
  if (error instanceof IdempotencyConflictError) {
    return { action: 'dead-letter', reason: 'IDEMPOTENCY_CONFLICT' };
  }
  if (error instanceof UnknownWalletError) {
    return { action: 'ack', reason: error.code };
  }
  if (error instanceof TransientInfrastructureError) {
    return { action: 'retry', reason: error.reason };
  }
  // Unknown errors are retried: the redrive policy dead-letters them if they keep failing.
  return { action: 'retry', reason: 'UNEXPECTED_ERROR' };
}
