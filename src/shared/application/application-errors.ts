/**
 * Errors raised by use cases. Like domain errors they carry a stable `code`; the HTTP exception
 * filter and the SQS error classifier map them to transport behaviour (ADR-0009, ADR-0010).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A queried resource does not exist (GET endpoints → 404). */
export class ResourceNotFoundError extends ApplicationError {
  readonly code: string;

  constructor(
    readonly resource: 'WALLET' | 'TRANSACTION',
    id: string,
  ) {
    super(`${resource.toLowerCase()} ${id} not found`);
    this.code = `${resource}_NOT_FOUND`;
  }
}

/**
 * A submission targets a wallet that does not exist. It is a business rejection, but it cannot be
 * stored as a transaction (foreign key), so it has no persisted outcome (ADR-0009).
 */
export class UnknownWalletError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} does not exist`);
  }
}

/** Same Idempotency-Key with a different payload, or an external id reused under another key. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly reason: 'PAYLOAD_MISMATCH' | 'EXTERNAL_ID_REUSED') {
    super(
      reason === 'PAYLOAD_MISMATCH'
        ? 'the Idempotency-Key was already used with a different payload'
        : 'the external transaction id was already used under another Idempotency-Key',
    );
  }
}

/** At most one wallet per player and currency (§6.2). */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('the pagination cursor is invalid');
  }
}

/** Temporary infrastructure failure: safe to retry (HTTP 503, SQS visibility backoff). */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TEMPORARILY_UNAVAILABLE';

  constructor(
    readonly reason: 'LOCK_TIMEOUT' | 'DATABASE_UNAVAILABLE' | 'SERIALIZATION_FAILURE',
    options?: { cause?: unknown },
  ) {
    super(`temporary infrastructure failure: ${reason}`);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A database uniqueness rule rejected a write; use cases decide what it means. */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`unique constraint violated: ${constraint ?? 'unknown'}`);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
