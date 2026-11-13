import { describe, expect, it } from 'bun:test';
import { canonicalJson } from '../../../../src/shared/domain/canonical-json';

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys recursively', () => {
    expect(canonicalJson({ z: { y: 1, x: { w: true, v: null } }, a: 'A' })).toBe(
      '{"a":"A","z":{"x":{"v":null,"w":true},"y":1}}',
    );
  });

  it('produces the same output regardless of the original key order', () => {
    const first = { providerId: 'p', money: { currency: 'BRL', amount: '1.00' }, kind: 'BET' };
    const second = { kind: 'BET', money: { amount: '1.00', currency: 'BRL' }, providerId: 'p' };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('keeps array order and canonicalizes array items', () => {
    expect(canonicalJson([{ b: 1, a: 1 }, 3, 'x'])).toBe('[{"a":1,"b":1},3,"x"]');
  });

  it('omits properties whose value is undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('escapes strings exactly like JSON', () => {
    expect(canonicalJson({ text: 'quote " and \\ and ü' })).toBe(
      '{"text":"quote \\" and \\\\ and ü"}',
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 10n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a Date', new Date(0)],
  ])('rejects %s, which has no stable JSON form', (_label, value) => {
    expect(() => canonicalJson({ value })).toThrow(TypeError);
  });
});
