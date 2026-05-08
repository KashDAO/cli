/**
 * Unit tests for `kash with-retry`'s pure helpers.
 *
 * The wrapper itself spawns a child process — that's exercised by
 * manual smoke tests during development. Here we focus on the pure
 * decision logic that drives the retry loop:
 *   - `parseErrorEnvelope` — tolerant JSON envelope extraction.
 *   - `decideRetry` — code-based retry policy.
 *   - `computeWait` — backoff calculation.
 */

import { describe, expect, it } from 'vitest';

import { computeWait, decideRetry, parseErrorEnvelope } from '../../src/commands/with-retry.js';

describe('parseErrorEnvelope', () => {
  it('extracts code, recoverable, and retryAfterMs from a single-line JSON envelope', () => {
    const stream = JSON.stringify({
      ok: false,
      error: { code: 'RATE_LIMITED', recoverable: true, retryAfterMs: 5_000 },
    });
    const env = parseErrorEnvelope(stream);
    expect(env?.error.code).toBe('RATE_LIMITED');
    expect(env?.error.recoverable).toBe(true);
    expect(env?.error.retryAfterMs).toBe(5_000);
  });

  it('extracts code from a pretty-printed multi-line envelope', () => {
    const stream =
      '{\n  "ok": false,\n  "error": {\n    "code": "NETWORK",\n    "recoverable": true\n  }\n}\n';
    const env = parseErrorEnvelope(stream);
    expect(env?.error.code).toBe('NETWORK');
    expect(env?.error.recoverable).toBe(true);
    expect(env?.error.retryAfterMs).toBeUndefined();
  });

  it('returns undefined when stream has no JSON envelope', () => {
    expect(parseErrorEnvelope('')).toBeUndefined();
    expect(parseErrorEnvelope('plain text error')).toBeUndefined();
    expect(parseErrorEnvelope('Some log line\nAnother log line')).toBeUndefined();
  });

  it('returns undefined when the envelope lacks a `code` string', () => {
    const stream = JSON.stringify({ ok: false, error: { recoverable: true } });
    expect(parseErrorEnvelope(stream)).toBeUndefined();
  });

  it('returns undefined when JSON parses but is not an envelope', () => {
    expect(parseErrorEnvelope('{}')).toBeUndefined();
    expect(parseErrorEnvelope('{"foo": "bar"}')).toBeUndefined();
  });

  it('picks the LAST envelope when multiple are present (the final, terminal one)', () => {
    // Common case: the inner CLI prints intermediate progress JSON
    // followed by the final error envelope.
    const stream = [
      JSON.stringify({ ok: false, error: { code: 'INTERIM_NOTICE', recoverable: true } }),
      JSON.stringify({ ok: false, error: { code: 'FINAL', recoverable: false } }),
    ].join('\n');
    const env = parseErrorEnvelope(stream);
    expect(env?.error.code).toBe('FINAL');
  });
});

describe('decideRetry', () => {
  it('returns true when the code is in the retryable allow-list', () => {
    expect(decideRetry('RATE_LIMITED', false)).toBe(true);
    expect(decideRetry('NETWORK', false)).toBe(true);
    expect(decideRetry('TIMEOUT', false)).toBe(true);
    expect(decideRetry('MAINTENANCE', false)).toBe(true);
    expect(decideRetry('SERVER_ERROR', false)).toBe(true);
  });

  it('returns false when the code is in the terminal deny-list', () => {
    expect(decideRetry('INVALID_INPUT', true)).toBe(false);
    expect(decideRetry('AUTH_REQUIRED', true)).toBe(false);
    expect(decideRetry('INSUFFICIENT_SCOPE', true)).toBe(false);
    expect(decideRetry('NOT_FOUND', true)).toBe(false);
    expect(decideRetry('CONFIGURATION', true)).toBe(false);
  });

  it('falls back to envelope.recoverable for unknown codes', () => {
    expect(decideRetry('SOME_FUTURE_CODE', true)).toBe(true);
    expect(decideRetry('SOME_FUTURE_CODE', false)).toBe(false);
  });

  it('assumes retryable when code is unknown and envelope.recoverable is missing', () => {
    expect(decideRetry('SOME_FUTURE_CODE', undefined)).toBe(true);
  });

  // Behavior change (DX round 5): retrying with no envelope was a
  // foot-gun — `with-retry -- trade buy <bad-id> ...` retried 5×
  // on INVALID_INPUT. The default is now "no envelope → fail fast";
  // callers who want unconditional retries pass --retry-without-json.
  it('does NOT retry when there is no envelope by default', () => {
    expect(decideRetry(undefined, undefined)).toBe(false);
  });

  it('retries on missing envelope when retryWithoutJson is true', () => {
    expect(decideRetry(undefined, undefined, { retryWithoutJson: true })).toBe(true);
  });

  it('allow-list wins over envelope.recoverable=false', () => {
    // Defensive: if the envelope claims a retryable code is not
    // recoverable, our knowledge of the catalog should still drive a
    // retry. Otherwise an envelope bug could nullify the retry loop.
    expect(decideRetry('RATE_LIMITED', false)).toBe(true);
  });

  it('deny-list wins over envelope.recoverable=true', () => {
    // Defensive symmetry: even if the server (incorrectly) says an
    // INVALID_INPUT is recoverable, we don't retry it.
    expect(decideRetry('INVALID_INPUT', true)).toBe(false);
  });
});

describe('computeWait', () => {
  const opts = { initialDelay: 1_000, maxDelay: 30_000 };

  it('uses retryAfterMs when present, capped by maxDelay', () => {
    expect(computeWait(5_000, 1, opts)).toBe(5_000);
    expect(computeWait(60_000, 1, opts)).toBe(30_000); // capped
  });

  it('falls back to exponential backoff when retryAfterMs is missing', () => {
    expect(computeWait(undefined, 1, opts)).toBe(1_000);
    expect(computeWait(undefined, 2, opts)).toBe(2_000);
    expect(computeWait(undefined, 3, opts)).toBe(4_000);
    expect(computeWait(undefined, 4, opts)).toBe(8_000);
  });

  it('caps exponential backoff at maxDelay', () => {
    expect(computeWait(undefined, 10, opts)).toBe(30_000);
    expect(computeWait(undefined, 20, opts)).toBe(30_000);
  });

  it('treats retryAfterMs <= 0 as missing (server bug guard)', () => {
    // A server returning 0 or negative would otherwise create a
    // tight retry loop. Falling back to exponential keeps us sane.
    expect(computeWait(0, 1, opts)).toBe(1_000);
    expect(computeWait(-1, 2, opts)).toBe(2_000);
  });

  it('respects custom initialDelay and maxDelay', () => {
    const custom = { initialDelay: 500, maxDelay: 2_000 };
    expect(computeWait(undefined, 1, custom)).toBe(500);
    expect(computeWait(undefined, 2, custom)).toBe(1_000);
    expect(computeWait(undefined, 3, custom)).toBe(2_000); // capped
    expect(computeWait(undefined, 4, custom)).toBe(2_000); // still capped
  });
});
