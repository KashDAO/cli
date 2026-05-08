/**
 * Unit tests for `utils/stdin.ts` — focused on the BOM-strip
 * contract since that's the load-bearing piece (every command that
 * accepts stdin or a file path routes its bytes through this module).
 *
 * The actual stdin-iterator paths are exercised via component tests
 * for each command that uses them; the pure `stripBom` helper covers
 * the byte-level guarantee.
 */

import { describe, expect, it } from 'vitest';

import { stripBom } from '../../../src/utils/stdin.js';

describe('stripBom', () => {
  // Notepad and VSCode (with files.encoding=utf8bom) prepend a U+FEFF
  // byte to UTF-8 files. Pasting the file content through a pipe
  // sends those three bytes verbatim into the CLI. Without this
  // strip, downstream consumers see `'\uFEFFkash_live_…'` and fail
  // their `kash_` prefix check; HMAC signing diverges from the
  // receiver's recompute; JSON.parse chokes on the leading non-
  // whitespace character.

  it('strips a leading U+FEFF (canonical UTF-8 BOM)', () => {
    expect(stripBom('\uFEFFhello')).toBe('hello');
  });

  it('passes through strings without a BOM unchanged', () => {
    expect(stripBom('hello')).toBe('hello');
  });

  it('only strips a leading BOM, not interior occurrences', () => {
    // U+FEFF is a real-world ZWNBSP code point in some contexts; only
    // the LEADING byte should be removed. Don't accidentally damage
    // payloads that legitimately carry the codepoint mid-string.
    expect(stripBom('a\uFEFFb')).toBe('a\uFEFFb');
  });

  it('handles the empty string', () => {
    expect(stripBom('')).toBe('');
  });

  it('handles a string that is JUST the BOM', () => {
    expect(stripBom('\uFEFF')).toBe('');
  });

  it('preserves trailing newlines (callers trim if they want)', () => {
    // The webhook-replay path signs body bytes byte-for-byte, so it
    // must not have surprise mutations beyond the leading-BOM strip.
    // Pin that no whitespace touching happens.
    expect(stripBom('\uFEFF{"k":"v"}\n')).toBe('{"k":"v"}\n');
  });

  it('is idempotent (already-stripped strings stay unchanged)', () => {
    const once = stripBom('\uFEFFhello');
    const twice = stripBom(once);
    expect(twice).toBe(once);
  });
});
