/**
 * Unit tests for the JSON serialisation contract in `output.ts`.
 *
 * Critical surface: every command's `--json` payload goes through
 * `printJson` / `writeNdjson`, which apply a single replacer function.
 * The replacer's contract is the load-bearing piece — agents pin to
 * the JSON shape, so any change to which values become `null` vs
 * `string` vs preserved is a SemVer-breaking event.
 *
 * Tests capture stdout via the existing harness, parse the JSON, and
 * assert on the shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureOutput, printJson, writeNdjson } from '../../../src/utils/output.js';
import { captureStreams } from '../../component/harness.js';

describe('printJson — bigint serialisation', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: true, noColor: true });
  });

  afterEach(() => teardown());

  it('serialises bigint to a decimal string (preserves precision)', () => {
    printJson({ amount: 12_345_678_901_234_567_890n });
    const json = JSON.parse(capture.stdout) as { amount: string };
    expect(json.amount).toBe('12345678901234567890');
  });

  it('serialises bigint inside a nested array', () => {
    printJson({ amounts: [1n, 2n, 3n] });
    const json = JSON.parse(capture.stdout) as { amounts: string[] };
    expect(json.amounts).toEqual(['1', '2', '3']);
  });

  it('does not stringify finite numbers', () => {
    printJson({ count: 42, ratio: 0.5 });
    const json = JSON.parse(capture.stdout) as { count: number; ratio: number };
    expect(json.count).toBe(42);
    expect(json.ratio).toBe(0.5);
  });
});

describe('printJson — non-finite number contract', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: true, noColor: true });
  });

  afterEach(() => teardown());

  it('coerces NaN to null (explicit; matches the documented contract)', () => {
    printJson({ ratio: NaN });
    const json = JSON.parse(capture.stdout) as { ratio: null };
    expect(json.ratio).toBeNull();
  });

  it('coerces Infinity to null', () => {
    printJson({ supply: Infinity });
    const json = JSON.parse(capture.stdout) as { supply: null };
    expect(json.supply).toBeNull();
  });

  it('coerces -Infinity to null', () => {
    printJson({ floor: -Infinity });
    const json = JSON.parse(capture.stdout) as { floor: null };
    expect(json.floor).toBeNull();
  });

  it('handles non-finite values nested in arrays', () => {
    printJson({ values: [1, NaN, 3, Infinity] });
    const json = JSON.parse(capture.stdout) as { values: (number | null)[] };
    expect(json.values).toEqual([1, null, 3, null]);
  });

  it('preserves null literals (no double-substitution)', () => {
    printJson({ txHash: null });
    const json = JSON.parse(capture.stdout) as { txHash: null };
    expect(json.txHash).toBeNull();
  });
});

describe('writeNdjson — bigint + non-finite', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: true, noColor: true });
  });

  afterEach(() => teardown());

  it('emits one record per line with bigints stringified', () => {
    writeNdjson({ id: 'a', amount: 100n });
    writeNdjson({ id: 'b', amount: 200n });
    const lines = capture.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: 'a', amount: '100' });
    expect(JSON.parse(lines[1]!)).toEqual({ id: 'b', amount: '200' });
  });

  it('coerces non-finite numbers in NDJSON entries to null', () => {
    writeNdjson({ id: 'x', ratio: NaN });
    const line = capture.stdout.trim();
    const parsed = JSON.parse(line) as { ratio: null };
    expect(parsed.ratio).toBeNull();
  });
});
