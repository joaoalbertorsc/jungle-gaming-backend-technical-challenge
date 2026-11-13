import { HttpException, HttpStatus } from '@nestjs/common';
import { InvalidWagerTransactionError } from '../../../modules/wagering/domain/wagering-errors';
import { InvalidWalletOperationError } from '../../../modules/wallet/domain/wallet-errors';
import {
  IdempotencyConflictError,
  InvalidCursorError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  UnknownWalletError,
  WalletAlreadyExistsError,
} from '../../application/application-errors';
import { CurrencyMismatchError, InvalidMoneyError } from '../../domain/errors';
import { MissingIdempotencyKeyError, RequestValidationError } from './http-errors';

export interface Problem {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly extras?: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;
}

/**
 * The single error → HTTP mapping (ADR-0009), used by every endpoint. A provider decides from the
 * status code and `code` alone: 400 fix the payload, 404 unknown resource, 409 idempotency or
 * uniqueness conflict, 422 business rejection, 503 retry later.
 */
export function problemFor(error: unknown): Problem {
  if (error instanceof RequestValidationError) {
    return problem(400, error.code, 'Request validation failed', error.message, {
      issues: error.issues,
    });
  }
  if (error instanceof MissingIdempotencyKeyError) {
    return problem(400, error.code, 'Idempotency-Key header required', error.message);
  }
  if (error instanceof InvalidWagerTransactionError) {
    return problem(400, error.code, 'Invalid wager transaction', error.message, {
      reason: error.reason,
    });
  }
  if (
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWalletOperationError ||
    error instanceof InvalidCursorError
  ) {
    return problem(400, error.code, 'Invalid request', error.message);
  }
  if (error instanceof ResourceNotFoundError) {
    return problem(404, error.code, 'Resource not found', error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return problem(409, error.code, 'Idempotency conflict', error.message, {
      reason: error.reason,
    });
  }
  if (error instanceof WalletAlreadyExistsError) {
    return problem(409, error.code, 'Wallet already exists', error.message);
  }
  if (error instanceof UnknownWalletError || error instanceof CurrencyMismatchError) {
    return problem(422, error.code, 'Business rule violated', error.message);
  }
  if (error instanceof TransientInfrastructureError) {
    return {
      ...problem(503, error.code, 'Temporarily unavailable', 'retry the same request later', {
        reason: error.reason,
      }),
      retryAfterSeconds: 1,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return problem(status, httpStatusName(status), httpStatusTitle(status), error.message);
  }
  if (isBodyParserError(error)) {
    return problem(
      400,
      'MALFORMED_JSON',
      'Malformed JSON body',
      'the request body is not valid JSON',
    );
  }
  return problem(500, 'INTERNAL_ERROR', 'Internal error', 'an unexpected error occurred');
}

function problem(
  status: number,
  code: string,
  title: string,
  detail: string,
  extras?: Record<string, unknown>,
): Problem {
  return extras === undefined
    ? { status, code, title, detail }
    : { status, code, title, detail, extras };
}

function httpStatusName(status: number): string {
  // Numeric enum: entries also hold the reverse (value → name) mappings, which never equal a number.
  const name = Object.entries(HttpStatus).find(([, value]) => Number(value) === status)?.[0];
  return name ?? `HTTP_${String(status)}`;
}

function httpStatusTitle(status: number): string {
  return httpStatusName(status)
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isBodyParserError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    (error as SyntaxError & { type?: string }).type === 'entity.parse.failed'
  );
}
