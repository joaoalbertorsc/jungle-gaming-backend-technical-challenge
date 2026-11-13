import { describe, expect, it } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../../../src/modules/wallet/application/ledger-cursor';
import { InvalidCursorError } from '../../../../../src/shared/application/application-errors';

describe('ledger cursor', () => {
  it('round-trips the last wallet version of a page', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(42))).toBe(42);
  });

  it('is opaque: URL-safe base64 without padding', () => {
    expect(encodeLedgerCursor(42)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('starts from the beginning when no cursor is given', () => {
    expect(decodeLedgerCursor(undefined)).toBe(0);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['valid base64 but not JSON', Buffer.from('hello').toString('base64url')],
    ['wrong version', Buffer.from(JSON.stringify({ v: 2, after: 1 })).toString('base64url')],
    ['negative position', Buffer.from(JSON.stringify({ v: 1, after: -1 })).toString('base64url')],
    ['fractional position', Buffer.from(JSON.stringify({ v: 1, after: 1.5 })).toString('base64url')],
  ])('rejects %s', (_label, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidCursorError);
  });
});
