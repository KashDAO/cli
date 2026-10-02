/**
 * The last-resort path in the error catalog.
 *
 * `lookupErrorCodeWithFallback` is what `toCliError` calls for every code,
 * including ones the mapper does not recognise. It had NO test, and it ended
 * `CATALOG_BY_CODE.get('UNEXPECTED')!` on the strength of a comment — so a
 * rename of that entry would have returned `undefined` typed as an
 * `ErrorCatalogEntry`, crashing on the path that exists to handle unrecognised
 * errors. The lookup is now a named constant, and these pin the contract that
 * made the assertion tempting in the first place.
 */

import { describe, it, expect } from 'vitest';

import {
  ERROR_CATALOG,
  ERROR_CODES,
  lookupErrorCode,
  lookupErrorCodeWithFallback,
} from '../../src/error-catalog.js';

describe('lookupErrorCodeWithFallback', () => {
  it('returns a usable entry for a code that is not in the catalog', () => {
    // The reason the function exists: an SDK error class the CLI has not
    // mapped yet must still explain itself rather than dead-end.
    const entry = lookupErrorCodeWithFallback('NO_SUCH_CODE_EXISTS');

    expect(entry).toBeDefined();
    expect(entry.code).toBe('UNEXPECTED');
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(entry.actions.length).toBeGreaterThan(0);
  });

  it('returns the catalog entry when the code is known', () => {
    const known = ERROR_CATALOG[0];
    expect(known).toBeDefined();
    expect(lookupErrorCodeWithFallback(known!.code)).toEqual(known);
  });

  it('serves the fallback entry from the catalog, not from beside it', () => {
    // The constant and the catalog must stay the same object: a second copy
    // would let `kash explain UNEXPECTED` and the fallback path drift apart.
    expect(ERROR_CODES.has('UNEXPECTED')).toBe(true);
    expect(lookupErrorCodeWithFallback('NO_SUCH_CODE_EXISTS')).toBe(lookupErrorCode('UNEXPECTED'));
  });
});
