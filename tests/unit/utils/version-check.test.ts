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

import { describe, expect, it } from 'vitest';

import { compareVersions } from '../../../src/utils/version-check.js';

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
