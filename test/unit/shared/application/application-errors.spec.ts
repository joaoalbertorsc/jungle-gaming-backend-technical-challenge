import { describe, expect, it } from 'bun:test';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidCursorError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  UnknownWalletError,
  WalletAlreadyExistsError,
} from '../../../../src/shared/application/application-errors';

/**
 * The error codes are a contract: the HTTP filter and the SQS classifier map them to transport
 * behaviour (ADR-0009, ADR-0010), so they must stay stable.
 */
describe('application errors', () => {
  it.each([
    [new ResourceNotFoundError('WALLET', 'w-1'), 'WALLET_NOT_FOUND'],
    [new ResourceNotFoundError('TRANSACTION', 't-1'), 'TRANSACTION_NOT_FOUND'],
    [new UnknownWalletError('w-1'), 'WALLET_NOT_FOUND'],
    [new IdempotencyConflictError('PAYLOAD_MISMATCH'), 'IDEMPOTENCY_CONFLICT'],
    [new IdempotencyConflictError('EXTERNAL_ID_REUSED'), 'IDEMPOTENCY_CONFLICT'],
    [new WalletAlreadyExistsError('p-1', 'BRL'), 'WALLET_ALREADY_EXISTS'],
    [new InvalidCursorError(), 'INVALID_CURSOR'],
    [new TransientInfrastructureError('LOCK_TIMEOUT'), 'TEMPORARILY_UNAVAILABLE'],
    [new UniqueViolationError('some_key'), 'UNIQUE_VIOLATION'],
  ])('%s carries the stable code %p', (error, code) => {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
  });

  it('explains both idempotency conflict reasons differently', () => {
    expect(new IdempotencyConflictError('PAYLOAD_MISMATCH').message).toContain('different payload');
    expect(new IdempotencyConflictError('EXTERNAL_ID_REUSED').message).toContain(
      'another Idempotency-Key',
    );
  });

  it('keeps the driver error as the cause of infrastructure errors', () => {
    const driverError = new Error('lock timeout');

    expect(new TransientInfrastructureError('LOCK_TIMEOUT', { cause: driverError }).cause).toBe(
      driverError,
    );
    expect(new UniqueViolationError('k', { cause: driverError }).cause).toBe(driverError);
  });

  it('names the violated constraint, or says it is unknown', () => {
    expect(new UniqueViolationError('wallets_player_currency_key').constraint).toBe(
      'wallets_player_currency_key',
    );
    expect(new UniqueViolationError(undefined).message).toContain('unknown');
  });
});
