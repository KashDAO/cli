/**
 * Unit tests for `isDebugOn` / `shouldPromoteDebug` — the helpers that
 * gate the "Re-run with --debug for verbose HTTP logs" hint on the
 * error path.
 *
 * The hint is a UX lever: surface it when verbose logs would actually
 * help (network/server errors), suppress it when they wouldn't (the
 * user's input is wrong; more logs won't fix that). And ALWAYS
 * suppress it when debug mode is already on — telling the user to
 * "re-run with --debug" while they're already running with --debug is
 * the kind of small UX miss that erodes trust in the tool.
 *
 * The bug this lock-in addresses: the pre-refactor check did a bare
 * presence test on `process.env['KASH_DEBUG']`, which is truthy for
 * the string `"0"` (any non-empty string is JS-truthy). But
 * readGlobals — the actual gate on whether --debug is on — uses
 * isTruthyEnv, which treats `"0"`, `"false"`, `"no"`, and `""` as
 * falsy. So `KASH_DEBUG=0` would not enable debug mode but would
 * still suppress the hint — confusing for users who set the var
 * defensively in their shell rc.
 */

import { describe, expect, it } from 'vitest';

import { isDebugOn, shouldPromoteDebug } from '../../src/utils/debug-hint.js';

describe('isDebugOn (argv + env resolution)', () => {
  describe('argv', () => {
    it('returns true when --debug is in argv', () => {
      // `process.argv` always has the first two entries as node + script.
      expect(isDebugOn(['node', '/path/to/kash', '--debug', 'trade', 'buy'], {})).toBe(true);
    });

    it('returns true when --debug is in argv even with falsy KASH_DEBUG', () => {
      expect(
        isDebugOn(['node', '/path', '--debug'], { KASH_DEBUG: '0' } as NodeJS.ProcessEnv)
      ).toBe(true);
    });

    it('does NOT match --debug-XXX or unrelated flags containing the substring', () => {
      // Exact-match semantics — a custom flag like `--debug-foo` must
      // not trip the gate.
      expect(isDebugOn(['node', '/path', '--debug-output'], {})).toBe(false);
      expect(isDebugOn(['node', '/path', '--undebug'], {})).toBe(false);
    });
  });

  describe('env (matches readGlobals isTruthyEnv rule)', () => {
    it.each([
      ['1', true],
      ['true', true],
      ['yes', true],
      ['on', true],
      ['TRUE', true], // case-insensitive
      ['Yes', true],
      ['  true  ', true], // trimmed
      ['0', false],
      ['false', false],
      ['no', false],
      ['off', false],
      ['', false], // empty string
      ['enabled', false], // not in the documented truthy set
      ['2', false], // only literal '1', not "any non-zero number"
    ])('KASH_DEBUG=%j → %s', (value, expected) => {
      expect(isDebugOn(['node', '/path'], { KASH_DEBUG: value } as NodeJS.ProcessEnv)).toBe(
        expected
      );
    });

    it('returns false when KASH_DEBUG is unset and no --debug flag', () => {
      expect(isDebugOn(['node', '/path'], {})).toBe(false);
    });
  });

  describe('the regression this guards (KASH_DEBUG=0 must NOT suppress the hint)', () => {
    it('KASH_DEBUG=0 alone → debug NOT on (the hint should still fire)', () => {
      // The previous implementation did `!process.env['KASH_DEBUG']`,
      // which treated "0" as truthy and skipped the hint. That left
      // users with `KASH_DEBUG=0` in their shell rc without the
      // suggested next step even though debug mode was off.
      expect(isDebugOn(['node', '/path'], { KASH_DEBUG: '0' } as NodeJS.ProcessEnv)).toBe(false);
    });

    it('KASH_DEBUG=false → debug NOT on', () => {
      expect(isDebugOn(['node', '/path'], { KASH_DEBUG: 'false' } as NodeJS.ProcessEnv)).toBe(
        false
      );
    });
  });
});

describe('shouldPromoteDebug', () => {
  // Validation / config / input errors don't benefit from more HTTP
  // logs — the cause is in the message. The hint should NOT fire
  // for these.
  it.each([
    'INVALID_INPUT',
    'CONFIGURATION',
    'INVALID_USEROP',
    'INSUFFICIENT_FUNDS',
    'INSUFFICIENT_GAS',
    'INSUFFICIENT_SCOPE',
  ])('returns false for %s (user fix, not log-needs-more)', (code) => {
    expect(shouldPromoteDebug(code)).toBe(false);
  });

  // Everything else benefits from verbose request/response traces.
  it.each([
    'NETWORK',
    'TIMEOUT',
    'RATE_LIMITED',
    'AUTH_FAILED',
    'SERVER_ERROR',
    'UNEXPECTED', // even the catch-all gets the hint — the user has nowhere else to look
  ])('returns true for %s (a verbose run would help)', (code) => {
    expect(shouldPromoteDebug(code)).toBe(true);
  });
});
