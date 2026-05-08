/**
 * Unit tests for `describeCommand` — the introspection helper that
 * powers `kash docs --json`. The shape pinned here is the AI-agent
 * contract: `aliases[]`, `long`, `short`, `flags` together describe
 * every spelling the CLI accepts.
 *
 * The interesting case is multi-long flag spec (e.g. `--timeout-ms,
 * --timeout`): Commander stores the second long as `short` and we
 * surface the extra spelling via `aliases[]`. Agents iterating
 * `[long, short, ...aliases]` get the full set without parsing the
 * raw `flags` string.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { describeCommand } from '../../../src/commands/docs.js';

describe('describeCommand — option aliases', () => {
  it('emits no aliases for a single-name flag', () => {
    const cmd = new Command('test').option('--limit <n>', 'page size');
    const docs = describeCommand(cmd);
    const limit = docs.options.find((o) => o.long === '--limit');
    expect(limit).toBeDefined();
    expect(limit?.aliases).toEqual([]);
  });

  it('emits no aliases for the canonical short+long pair', () => {
    const cmd = new Command('test').option('-l, --limit <n>', 'page size');
    const docs = describeCommand(cmd);
    const limit = docs.options.find((o) => o.long === '--limit');
    expect(limit).toBeDefined();
    expect(limit?.short).toBe('-l');
    expect(limit?.aliases).toEqual([]);
  });

  it('surfaces a long-form alias when the flag spec declares two long names', () => {
    // The exact spec we use on `kash trade buy/sell/status`:
    // canonical `--timeout-ms` aliased to legacy `--timeout`.
    const cmd = new Command('test').option('--timeout-ms, --timeout <ms>', 'wait timeout');
    const docs = describeCommand(cmd);
    const timeout = docs.options[0];
    expect(timeout).toBeDefined();
    // Agents iterate `[long, short, ...aliases].filter(Boolean)` to
    // get every accepted spelling. The exact assignment between
    // long/short/aliases is an implementation detail of Commander —
    // what matters is that BOTH `--timeout-ms` and `--timeout` show
    // up in the union somewhere.
    const allSpellings = [timeout!.long, timeout!.short, ...timeout!.aliases].filter(Boolean);
    expect(allSpellings).toContain('--timeout');
    expect(allSpellings).toContain('--timeout-ms');
  });

  it('emits the same alias structure for short-aliased canonical longs', () => {
    // `-c, --cursor` has only one long — no alias surface needed.
    const cmd = new Command('test').option('-c, --cursor <c>', 'pagination cursor');
    const docs = describeCommand(cmd);
    const cursor = docs.options[0];
    expect(cursor?.aliases).toEqual([]);
  });

  it('preserves the original `flags` string verbatim for downstream parsers', () => {
    // The `flags` field is the raw spec — agents that prefer to
    // parse it themselves (e.g. for shell completion generation)
    // get the unmodified value. Pin the contract.
    const cmd = new Command('test').option('--timeout-ms, --timeout <ms>', 'wait timeout');
    const docs = describeCommand(cmd);
    expect(docs.options[0]?.flags).toBe('--timeout-ms, --timeout <ms>');
  });
});
