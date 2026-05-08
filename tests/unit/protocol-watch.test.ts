/**
 * Unit tests for `kash protocol watch`'s pure helpers and the
 * NDJSON wire shape it emits.
 *
 * The full long-running command body holds a never-resolving promise
 * (it terminates via SIGINT, --max-events, or --timeout-ms calling
 * `process.exit`), which is awkward to test end-to-end without
 * spinning up a real RPC. Instead we test:
 *
 *   - `formatEventHuman` — the one-liner the human-mode renderer emits.
 *   - The NDJSON wire shape via `writeNdjson` — confirms the canonical
 *     `jsonReplacer` (in `utils/output.ts`) handles every bigint
 *     field on every event variant, including arrays of bigints.
 *     Used to live in a now-deleted local `serializeEvent` helper;
 *     the tests follow the encoder to its single source of truth.
 *
 * Address validation is exercised by the existing `runViaProgram`
 * harness in `protocol-utils.test.ts` (offline) and the SDK call
 * shape is already covered by integration with the real chain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatEventHuman, type WatchEventLike } from '../../src/commands/protocol/watch.js';
import { configureOutput, writeNdjson } from '../../src/utils/output.js';
import { captureStreams } from '../component/harness.js';

const SA = '0xfedcba0987654321fedcba0987654321fedcba09' as const;
const TX_HASH = `0x${'a'.repeat(64)}` as const;

const TRADE_EVENT: WatchEventLike = {
  type: 'TRADE',
  side: 'buy',
  outcome: 0,
  receiver: SA as `0x${string}`,
  assetsUsdc: 10_000_000n,
  tokensWad: 15_000_000_000_000_000_000n,
  reserveAfterWad: 500_000_000_000_000_000_000n,
  supplyAfterWad: [1_500_000_000_000_000_000_000n, 1_000_000_000_000_000_000_000n],
  blockNumber: 12_345n,
  transactionHash: TX_HASH,
  logIndex: 0,
};

const RESOLVED_EVENT: WatchEventLike = {
  type: 'RESOLVED',
  winningOutcome: 1,
  evidenceHash: TX_HASH,
  blockNumber: 99n,
  transactionHash: TX_HASH,
  logIndex: 0,
};

const FROZEN_EVENT: WatchEventLike = {
  type: 'FROZEN',
  observedAt: 1_700_000_000n,
  blockNumber: 88n,
  transactionHash: TX_HASH,
  logIndex: 0,
};

describe('writeNdjson on watch events — bigint encoding contract', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: true, noColor: true });
  });

  afterEach(() => teardown());

  it('stringifies every bigint field on a TRADE event', () => {
    writeNdjson(TRADE_EVENT);
    const out = JSON.parse(capture.stdout.trim()) as {
      type: string;
      side: string;
      outcome: number;
      assetsUsdc: string;
      tokensWad: string;
      reserveAfterWad: string;
      blockNumber: string;
      logIndex: number;
    };
    expect(out.type).toBe('TRADE');
    expect(out.side).toBe('buy');
    expect(out.outcome).toBe(0); // number, not stringified
    expect(out.assetsUsdc).toBe('10000000');
    expect(out.tokensWad).toBe('15000000000000000000');
    expect(out.reserveAfterWad).toBe('500000000000000000000');
    expect(out.blockNumber).toBe('12345');
    expect(out.logIndex).toBe(0); // number, not stringified
  });

  it('stringifies every entry in supplyAfterWad (array-of-bigint)', () => {
    writeNdjson(TRADE_EVENT);
    const out = JSON.parse(capture.stdout.trim()) as { supplyAfterWad: string[] };
    expect(out.supplyAfterWad).toEqual(['1500000000000000000000', '1000000000000000000000']);
  });

  it('emits one valid JSON line per event for all three event types', () => {
    writeNdjson(TRADE_EVENT);
    writeNdjson(RESOLVED_EVENT);
    writeNdjson(FROZEN_EVENT);
    const lines = capture.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    // Each line is parseable JSON — failure here would mean a bigint leaked.
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
  });

  it('preserves the discriminator across all three event types', () => {
    writeNdjson(TRADE_EVENT);
    writeNdjson(RESOLVED_EVENT);
    writeNdjson(FROZEN_EVENT);
    const [a, b, c] = capture.stdout.trim().split('\n');
    expect((JSON.parse(a!) as { type: string }).type).toBe('TRADE');
    expect((JSON.parse(b!) as { type: string }).type).toBe('RESOLVED');
    expect((JSON.parse(c!) as { type: string }).type).toBe('FROZEN');
  });

  it('serializes RESOLVED events without leaking TRADE-only fields', () => {
    writeNdjson(RESOLVED_EVENT);
    const out = JSON.parse(capture.stdout.trim()) as Record<string, unknown>;
    expect(out['type']).toBe('RESOLVED');
    expect(out['winningOutcome']).toBe(1);
    expect(out['evidenceHash']).toBe(TX_HASH);
    expect(out['blockNumber']).toBe('99');
    // Should NOT carry TRADE-only fields.
    expect(out['assetsUsdc']).toBeUndefined();
    expect(out['supplyAfterWad']).toBeUndefined();
  });

  it('serializes FROZEN events with `observedAt` as a string', () => {
    writeNdjson(FROZEN_EVENT);
    const out = JSON.parse(capture.stdout.trim()) as Record<string, unknown>;
    expect(out['type']).toBe('FROZEN');
    expect(out['observedAt']).toBe('1700000000');
    expect(out['blockNumber']).toBe('88');
  });
});

describe('formatEventHuman', () => {
  it('produces a single-line summary for TRADE events', () => {
    const line = formatEventHuman(TRADE_EVENT);
    expect(line).toContain('TRADE');
    expect(line).toContain('side=buy');
    expect(line).toContain('out=0');
    expect(line).toContain('usdc=10000000');
    // Truncated transaction hash (10 chars + ellipsis).
    expect(line).toContain(TX_HASH.slice(0, 10));
    expect(line).not.toContain('\n');
  });

  it('produces a single-line summary for RESOLVED events', () => {
    const line = formatEventHuman(RESOLVED_EVENT);
    expect(line).toContain('RESOLVED');
    expect(line).toContain('winner=1');
    expect(line).not.toContain('\n');
  });

  it('produces a single-line summary for FROZEN events', () => {
    const line = formatEventHuman(FROZEN_EVENT);
    expect(line).toContain('FROZEN');
    expect(line).toContain('observedAt=1700000000');
    expect(line).not.toContain('\n');
  });
});
