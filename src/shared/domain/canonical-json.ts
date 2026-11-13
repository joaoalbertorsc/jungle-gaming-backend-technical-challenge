/**
 * Deterministic JSON: object keys sorted recursively, no insignificant whitespace, `undefined`
 * properties omitted. Two structurally equal values always serialize to the same string, which is
 * what makes payload hashes stable (ADR-0008).
 *
 * Values without a stable JSON form (NaN, Infinity, bigint, functions, symbols, Dates) are rejected:
 * callers must normalize them first.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`);
      return JSON.stringify(value);
    case 'object':
      return Array.isArray(value) ? serializeArray(value, path) : serializeObject(value, path);
    default:
      throw new TypeError(`${path}: unsupported ${typeof value} value`);
  }
}

function serializeArray(items: readonly unknown[], path: string): string {
  return `[${items.map((item, index) => serialize(item, `${path}[${String(index)}]`)).join(',')}]`;
}

function serializeObject(value: object, path: string): string {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path}: only plain objects are supported`);
  }

  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry, `${path}.${key}`)}`);
  return `{${entries.join(',')}}`;
}
