/** Errors raised by the HTTP adapter itself (before any use case runs). */

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** The request body, params or query failed schema validation. */
export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_FAILED';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`request validation failed: ${issues.map((issue) => issue.path).join(', ')}`);
    this.name = 'RequestValidationError';
  }
}

/** POST /wagering/transactions without a usable Idempotency-Key header (§9). */
export class MissingIdempotencyKeyError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';

  constructor() {
    super('the Idempotency-Key header is required (1 to 255 characters)');
    this.name = 'MissingIdempotencyKeyError';
  }
}
