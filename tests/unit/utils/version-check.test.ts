/**
 * Unit tests for `compareVersions` in `utils/version-check.ts`.
 *
 * The helper gates the user-visible `isOutdated` flag returned by
 * `kash version --check`. A regression here would either nag the
 * user with false positives (mid-flight false alarms) or silently
 * swallow real updates (the worse failure mode for a CLI tool that
 * users assume keeps itself in sync).
 *
 * Documented contract: returns `1` when `a > b`, `-1` when `a < b`,
 * `0` when equal OR when either side fails the semver regex (the
 * "treat as up-to-date rather than nag" guarantee).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkLatestVersion,
  compareVersions,
  isOptedOut,
} from '../../../src/utils/version-check.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns 1 when a > b on patch', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
  });

  it('returns -1 when a < b on patch', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });

  it('returns 1 when a > b on minor (patch ignored)', () => {
    expect(compareVersions('1.3.0', '1.2.99')).toBe(1);
  });

  it('returns -1 when a < b on minor', () => {
    expect(compareVersions('1.2.99', '1.3.0')).toBe(-1);
  });

  it('returns 1 when a > b on major (minor.patch ignored)', () => {
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });

  it('returns -1 when a < b on major', () => {
    expect(compareVersions('1.99.99', '2.0.0')).toBe(-1);
  });

  it('ignores pre-release / build metadata when comparing', () => {
    // Documented behaviour: only the major.minor.patch triple matters
    // for the "you're behind" prompt. `1.2.3-beta` and `1.2.3+build`
    // both compare equal to `1.2.3`.
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.3+build.42')).toBe(0);
  });

  it('returns 0 when either side fails the semver regex (never-nag guarantee)', () => {
    expect(compareVersions('not-a-version', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', 'not-a-version')).toBe(0);
    expect(compareVersions('foo', 'bar')).toBe(0);
    expect(compareVersions('', '1.2.3')).toBe(0);
  });

  it('handles double-digit segments correctly (lex-order would mis-rank)', () => {
    // Naive lexicographic comparison would say "1.10.0" < "1.9.0".
    // Numeric comparison must say "1.10.0" > "1.9.0".
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  it('handles 0.x.y correctly (the common pre-1.0 release shape)', () => {
    expect(compareVersions('0.1.0', '0.0.99')).toBe(1);
    expect(compareVersions('0.0.99', '0.1.0')).toBe(-1);
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
  });

  it('accepts a leading "v" via downstream normalization (NOT here)', () => {
    // `compareVersions` itself does NOT strip a leading "v" — that's
    // the caller's job (npm registry returns bare semver, GitHub tags
    // include "v"). Pin the current behaviour so any future strip
    // change is intentional.
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0); // both regex-fail at 'v', return 0 by contract
  });
});

describe('isOptedOut (KASH_NO_UPDATE_CHECK)', () => {
  const ORIGINAL = process.env['KASH_NO_UPDATE_CHECK'];

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env['KASH_NO_UPDATE_CHECK'];
    } else {
      process.env['KASH_NO_UPDATE_CHECK'] = ORIGINAL;
    }
  });

  it('returns false when the env var is unset', () => {
    delete process.env['KASH_NO_UPDATE_CHECK'];
    expect(isOptedOut()).toBe(false);
  });

  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true], // case-insensitive
    ['Yes', true],
    ['ON', true],
    ['  true  ', true], // trimmed
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['', false],
    ['enabled', false], // not in the truthy list — only the 4 documented values
    ['2', false], // only literal '1' is truthy, not "any non-zero number"
  ])('KASH_NO_UPDATE_CHECK=%j → %s', (value, expected) => {
    process.env['KASH_NO_UPDATE_CHECK'] = value;
    expect(isOptedOut()).toBe(expected);
  });
});

describe('checkLatestVersion — opt-out short-circuit', () => {
  // The opt-out path is the hot one for air-gapped + corporate-egress
  // users: a single env var must skip the fetch AND not touch the cache
  // file. Verifying both invariants together — the opt-out is a hard
  // exit, not a "check the cache but skip the fetch" softer version.

  const ORIGINAL = process.env['KASH_NO_UPDATE_CHECK'];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '9.9.9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (ORIGINAL === undefined) {
      delete process.env['KASH_NO_UPDATE_CHECK'];
    } else {
      process.env['KASH_NO_UPDATE_CHECK'] = ORIGINAL;
    }
  });

  it('opt-out: never calls fetch and returns latestVersion=null', async () => {
    process.env['KASH_NO_UPDATE_CHECK'] = '1';
    const result = await checkLatestVersion('1.2.3');
    expect(result.latestVersion).toBeNull();
    expect(result.isOutdated).toBe(false);
    expect(result.fromCache).toBe(false);
    expect(result.lastCheckedAt).toBeNull();
    expect(result.current).toBe('1.2.3');
    // The fundamental opt-out invariant: zero network traffic.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('non-truthy KASH_NO_UPDATE_CHECK does NOT short-circuit (opt-out stays opt-out)', async () => {
    // Falsy value '0' must not trigger the opt-out path. We can't
    // deterministically assert that fetch was called (a fresh cache
    // from a prior run would absorb the lookup), but we CAN assert
    // that the return shape is the non-opt-out shape: either
    // `fromCache: true` (cache hit, fetch skipped because cache is
    // fresh) OR `lastCheckedAt !== null` (fetch ran). The opt-out
    // shape is the only one that returns BOTH `fromCache: false`
    // AND `lastCheckedAt: null` — any other shape proves the opt-out
    // gate didn't fire.
    process.env['KASH_NO_UPDATE_CHECK'] = '0';
    const result = await checkLatestVersion('1.2.3');
    const isOptOutShape = result.fromCache === false && result.lastCheckedAt === null;
    expect(isOptOutShape).toBe(false);
  });
});
