import { describe, expect, it } from 'bun:test';
import {
  CrashAt,
  FAULT_CRASH_EXIT_CODE,
} from '../../../../src/infrastructure/system/system-adapters';

/** ADR-0017: the env-gated crash used by the concurrency suite (kill after commit, before ack). */
describe('CrashAt', () => {
  it('ends the process at its fault point and nowhere else', () => {
    const exits: number[] = [];
    const faults = new CrashAt('consumer.before-ack', (code) => {
      exits.push(code);
    });

    faults.hit('wager.before-commit');
    expect(exits).toEqual([]);

    faults.hit('consumer.before-ack');
    expect(exits).toEqual([FAULT_CRASH_EXIT_CODE]);
  });
});
