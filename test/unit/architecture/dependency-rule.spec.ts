import { describe, expect, it } from 'bun:test';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Enforces the dependency rule of ADR-0003:
 * - domain code is plain TypeScript: no framework, ORM, SDK or validation library, and no import
 *   from application, infrastructure or interface layers (§6.1);
 * - application code never reaches into infrastructure or interface layers.
 */
const SRC = resolve(import.meta.dir, '../../../src');
const OUTER_LAYERS = ['application', 'infrastructure', 'interface'];
const FORBIDDEN_IN_DOMAIN =
  /^(@nestjs|@mikro-orm|@aws-sdk|zod|express|rxjs|pino|reflect-metadata)(\/|$)/;
const FORBIDDEN_IN_APPLICATION = /^(@mikro-orm|@aws-sdk|express)(\/|$)/;
const IMPORT_PATTERN =
  /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

interface Violation {
  readonly file: string;
  readonly specifier: string;
}

async function sourceFiles(layer: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of new Bun.Glob(`**/${layer}/**/*.ts`).scan(SRC))
    files.push(join(SRC, file));
  return files;
}

async function importsOf(file: string): Promise<string[]> {
  const text = await Bun.file(file).text();
  return [...text.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2] ?? '');
}

function crossesInto(file: string, specifier: string, layers: readonly string[]): boolean {
  if (!specifier.startsWith('.')) return false;
  const target = relative(SRC, resolve(dirname(file), specifier)).split(/[\\/]/);
  return (
    target.some((segment) => layers.includes(segment)) ||
    ['config', 'bootstrap'].includes(target[0] ?? '')
  );
}

async function violations(
  layer: string,
  forbiddenPackages: RegExp,
  forbiddenLayers: readonly string[],
): Promise<Violation[]> {
  const found: Violation[] = [];
  for (const file of await sourceFiles(layer)) {
    for (const specifier of await importsOf(file)) {
      if (forbiddenPackages.test(specifier) || crossesInto(file, specifier, forbiddenLayers)) {
        found.push({ file: relative(SRC, file), specifier });
      }
    }
  }
  return found;
}

describe('dependency rule (ADR-0003)', () => {
  it('scans a non-empty domain layer (guards against a vacuous pass)', async () => {
    expect((await sourceFiles('domain')).length).toBeGreaterThan(10);
  });

  it('keeps the domain free of frameworks, ORM, SDKs and outer layers', async () => {
    expect(await violations('domain', FORBIDDEN_IN_DOMAIN, OUTER_LAYERS)).toEqual([]);
  });

  it('keeps the application layer free of infrastructure and interface code', async () => {
    expect(
      await violations('application', FORBIDDEN_IN_APPLICATION, ['infrastructure', 'interface']),
    ).toEqual([]);
  });

  it('detects a violation when one exists (self-check of the scanner)', () => {
    const file = join(SRC, 'modules/wallet/domain/wallet.ts');

    expect(FORBIDDEN_IN_DOMAIN.test('@mikro-orm/core')).toBe(true);
    expect(crossesInto(file, '../infrastructure/wallet.repository', OUTER_LAYERS)).toBe(true);
    expect(crossesInto(file, '../../../config/load-config', OUTER_LAYERS)).toBe(true);
    expect(crossesInto(file, './wallet-errors', OUTER_LAYERS)).toBe(false);
  });
});
