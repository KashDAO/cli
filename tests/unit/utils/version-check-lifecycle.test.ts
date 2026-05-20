/**
 * `checkLatestVersion` cache lifecycle.
 *
 * Round T closed a real KASH_CONFIG-redirect bug; round U added the
 * opt-out path. Neither pinned the actual cache lifecycle —
 * cold-miss → fetch → write, warm-hit < TTL → skip fetch, stale →
 * refetch, network-failure → return stale-with-cached-timestamp.
 *
 * Each transition matters for the customer experience:
 *
 *   - Cold miss must write the cache file or every invocation pays
 *     the npm registry round-trip.
 *   - Warm hit must skip fetch or `kash version --check` is slow on
 *     repeat use.
 *   - Stale must refetch or customers stop seeing update prompts.
 *   - Network failure must fall back to the cached value, NOT throw,
 *     or a transient registry outage breaks the version command for
 *     every user on the network blip.
 *
 * Tests isolate disk state by redirecting `KASH_CONFIG` to a per-test
 * tmp directory (round T fixed cachePath() to honor that env var, so
 * we can use it here for clean test isolation).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkLatestVersion } from '../../../src/utils/version-check.js';

const NPM_REGISTRY_RESPONSE = (version: string) =>
  new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('checkLatestVersion — cache lifecycle', () => {
  let tmpDir: string;
  let cachePath: string;
  let originalConfig: string | undefined;
  let originalOptOut: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Isolate each test's cache via KASH_CONFIG redirect (round T).
    tmpDir = mkdtempSync(join(tmpdir(), 'kash-version-check-'));
    cachePath = join(tmpDir, 'version-check.json');
    originalConfig = process.env['KASH_CONFIG'];
    originalOptOut = process.env['KASH_NO_UPDATE_CHECK'];
    process.env['KASH_CONFIG'] = join(tmpDir, 'config.json');
    delete process.env['KASH_NO_UPDATE_CHECK'];

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(NPM_REGISTRY_RESPONSE('9.9.9'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalConfig === undefined) {
      delete process.env['KASH_CONFIG'];
    } else {
      process.env['KASH_CONFIG'] = originalConfig;
    }
    if (originalOptOut === undefined) {
      delete process.env['KASH_NO_UPDATE_CHECK'];
    } else {
      process.env['KASH_NO_UPDATE_CHECK'] = originalOptOut;
    }
  });

  it('cold miss: no cache → fetch called → cache file written', async () => {
    expect(existsSync(cachePath)).toBe(false);

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.latestVersion).toBe('9.9.9');
    expect(result.isOutdated).toBe(true); // 9.9.9 > 1.2.3
    expect(result.fromCache).toBe(false);
    expect(result.lastCheckedAt).not.toBeNull();

    // Cache file must be on disk for the next invocation.
    expect(existsSync(cachePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      checkedAt: string;
      latestVersion: string;
    };
    expect(persisted.latestVersion).toBe('9.9.9');
    expect(typeof persisted.checkedAt).toBe('string');
  });

  it('warm hit: fresh cache (< 24h) → fetch NOT called, fromCache=true', async () => {
    // Pre-populate the cache with a fresh entry. The CACHE_TTL_MS is
    // 24h; "fresh" means anything younger than that.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ checkedAt: oneHourAgo, latestVersion: '5.0.0' }));

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.latestVersion).toBe('5.0.0');
    expect(result.fromCache).toBe(true);
    expect(result.lastCheckedAt).toBe(oneHourAgo);
    expect(result.isOutdated).toBe(true); // 5.0.0 > 1.2.3
  });

  it('warm hit: equal version → isOutdated=false', async () => {
    // Boundary: customer is on the latest. The hint must NOT fire.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ checkedAt: oneHourAgo, latestVersion: '1.2.3' }));

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.isOutdated).toBe(false);
    expect(result.fromCache).toBe(true);
  });

  it('stale cache (> 24h): cache present → fetch called → cache overwritten', async () => {
    // Cache 25h old — past the TTL. Must refetch and persist.
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      cachePath,
      JSON.stringify({ checkedAt: twentyFiveHoursAgo, latestVersion: '5.0.0' })
    );

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.latestVersion).toBe('9.9.9'); // fresh from registry, not the 5.0.0 stale
    expect(result.fromCache).toBe(false);
    expect(result.lastCheckedAt).not.toBe(twentyFiveHoursAgo); // overwritten

    // Disk-side: the new value replaced the stale one.
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      checkedAt: string;
      latestVersion: string;
    };
    expect(persisted.latestVersion).toBe('9.9.9');
  });

  it('fetch failure with prior cache: returns cached value, fromCache=true, retains stale timestamp', async () => {
    // The transient-outage case — most important behavioural lever.
    // A registry blip must NOT break `kash version --check`; it must
    // fall back to whatever was cached, even if stale.
    const oldCheckedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ checkedAt: oldCheckedAt, latestVersion: '5.0.0' }));

    // Fetch fails — simulate either network error or non-2xx.
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.latestVersion).toBe('5.0.0'); // cached value, not null
    expect(result.fromCache).toBe(true);
    expect(result.lastCheckedAt).toBe(oldCheckedAt); // retains stale timestamp
    expect(result.isOutdated).toBe(true); // still computed from cached value
  });

  it('fetch failure without prior cache: latestVersion=null, no cache written', async () => {
    expect(existsSync(cachePath)).toBe(false);
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.latestVersion).toBeNull();
    expect(result.fromCache).toBe(false);
    expect(result.lastCheckedAt).toBeNull();
    expect(result.isOutdated).toBe(false);

    // No cache file created on a failed cold lookup — otherwise the
    // next invocation would treat null as the cached value and skip
    // future fetches.
    expect(existsSync(cachePath)).toBe(false);
  });

  it('corrupted cache file: parses as null, behaves as cold miss', async () => {
    // Defence-in-depth: a half-written cache from a crashed prior
    // run, a manual edit, or a disk-corruption event must not crash
    // the version command. The implementation catches JSON.parse
    // errors and treats them as "no cache."
    writeFileSync(cachePath, 'not valid json {{{');

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).toHaveBeenCalledOnce(); // treated as cold miss
    expect(result.latestVersion).toBe('9.9.9');
    expect(result.fromCache).toBe(false);

    // Fresh cache overwrites the corrupted one.
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      latestVersion: string;
    };
    expect(persisted.latestVersion).toBe('9.9.9');
  });

  it('cache TTL boundary: at exactly 24h, treats as stale (>= boundary)', async () => {
    // Pin the boundary. The implementation uses `age < CACHE_TTL_MS`,
    // so exactly at the TTL is stale. A regression that flipped to
    // `<=` would extend cache lifetime by one tick per call —
    // observable only after sustained use.
    const exactlyTtl = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ checkedAt: exactlyTtl, latestVersion: '5.0.0' }));

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).toHaveBeenCalledOnce(); // refetched, not cached
    expect(result.fromCache).toBe(false);
  });

  it('cache TTL boundary: just under 24h, hits cache', async () => {
    // The flip side: 1 second under the boundary still uses cache.
    const justUnderTtl = new Date(Date.now() - 24 * 60 * 60 * 1000 + 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ checkedAt: justUnderTtl, latestVersion: '5.0.0' }));

    const result = await checkLatestVersion('1.2.3');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
  });

  it('fetch response without version field: treated as failure', async () => {
    // npm returns the latest manifest; the version field is required
    // for the cache write. If npm ever ships a malformed response —
    // or an intermediary proxy strips the field — fall back to the
    // cached value rather than persisting garbage.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ name: '@kashdao/cli' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await checkLatestVersion('1.2.3');

    expect(result.latestVersion).toBeNull();
    expect(result.fromCache).toBe(false);
    // No cache write — the registry contract was violated; we don't
    // want to persist `null` as the latest version.
    expect(existsSync(cachePath)).toBe(false);
  });

  it('fetch returns non-2xx: treated as failure', async () => {
    // npm 5xx or rate-limited (429). Same fallback path as a network
    // error.
    fetchSpy.mockResolvedValue(
      new Response('Service Unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      })
    );

    const result = await checkLatestVersion('1.2.3');

    expect(result.latestVersion).toBeNull();
    expect(result.fromCache).toBe(false);
  });
});
