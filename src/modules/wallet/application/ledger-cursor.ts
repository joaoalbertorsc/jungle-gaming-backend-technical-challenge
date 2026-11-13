import { InvalidCursorError } from '../../../shared/application/application-errors';

const CURSOR_VERSION = 1;

/**
 * Opaque, stable ledger cursor (ADR-0013): base64url of `{ v, after }`, where `after` is the last
 * wallet version returned. Wallet versions are gap-free and immutable, so pages never shift.
 */
export function encodeLedgerCursor(lastWalletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, after: lastWalletVersion })).toString(
    'base64url',
  );
}

/** Position to continue after; 0 (the beginning) when there is no cursor. */
export function decodeLedgerCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }

  const { v, after } = (decoded ?? {}) as { v?: unknown; after?: unknown };
  if (v !== CURSOR_VERSION || typeof after !== 'number' || !Number.isInteger(after) || after < 0) {
    throw new InvalidCursorError();
  }
  return after;
}
