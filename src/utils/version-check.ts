/**
 * Probe npm for a newer `@kashdao/cli` release and cache the result.
 *
 * The probe is opt-in (currently `kash version --check`). It is NOT
 * called automatically on every invocation — too much traffic, too
 * much latency, too much noise for a user who never asked. When opt-in,
 * we:
 *
 *   1. Read a cached `{ checkedAt, latestVersion }` from
 *      `~/.kash/version-check.json`.
 *   2. If the cache is fresher than 24h, return it.
 *   3. Otherwise fetch `https://registry.npmjs.org/@kashdao/cli/latest`
 *      with a tight 5s timeout, update the cache, return.
 *   4. On any network error, return `latestVersion: null`. We never
 *      throw — a flaky network shouldn't break `kash version`.
 *
 * Cache file lives in the same directory as the main config so users
 * can wipe both with `rm -rf ~/.kash`. We don't reuse the config
 * file's writer because it goes through Zod validation and would
 * round-trip the entire config on every cache write.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveConfigPaths } from './config-store.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@kashdao/cli/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5_000;

export type VersionCheckResult = {
  /** The CLI version baked into this build (`CLI_VERSION`). */
  readonly current: string;
  /** Latest published version from npm; `null` if the probe failed. */
  readonly latestVersion: string | null;
  /** True iff `latestVersion` is strictly greater than `current`. */
  readonly isOutdated: boolean;
  /** ISO-8601 timestamp of when the latest version was last fetched. */
  readonly lastCheckedAt: string | null;
  /** True iff the result came from the on-disk cache (not a fresh fetch). */
  readonly fromCache: boolean;
};

type CacheFile = {
  readonly checkedAt: string;
  readonly latestVersion: string;
};

function cachePath(): string {
  // Place the cache next to the config file so `rm -rf ~/.kash` wipes
  // both. We pull the directory from `resolveConfigPaths` rather than
  // hard-coding `~/.kash` so `KASH_CONFIG=/tmp/foo.json` redirects
  // here too.
  const { file } = resolveConfigPaths();
  return join(dirname(file), 'version-check.json');
}

async function readCache(): Promise<CacheFile | null> {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (typeof parsed.checkedAt === 'string' && typeof parsed.latestVersion === 'string') {
      return { checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion };
    }
    return null;
  } catch {
    // Corrupted cache → ignore. The fresh fetch will overwrite it.
    return null;
  }
}

async function writeCache(latestVersion: string): Promise<void> {
  const path = cachePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const payload: CacheFile = {
      checkedAt: new Date().toISOString(),
      latestVersion,
    };
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Best-effort — read-only filesystems and friends shouldn't break
    // the main flow.
  }
}

/**
 * The CLI is a published-to-npm public package that intentionally
 * has zero `@kashdao/*` runtime deps beyond `@kashdao/sdk` and
 * `@kashdao/protocol-sdk` (enforced by sync-to-public-mirror.ts).
 * Pulling in `@kashdao/http-client` would break that invariant.
 * This call is non-critical (best-effort version-update notice),
 * short-lived (caller-supplied AbortSignal), and to a single
 * well-known host (the npm registry) — all guarantees that the
 * `HttpClient` rule exists to enforce.
 */
async function fetchLatest(signal: AbortSignal): Promise<string | null> {
  try {
    const response = await /* eslint-disable-line @kashdao/no-bare-fetch */ fetch(
      NPM_REGISTRY_URL,
      {
        signal,
        headers: { accept: 'application/json' },
      }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version === 'string' && body.version.length > 0) {
      return body.version;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compare two semver-shaped strings. Returns `1` if a > b, `-1` if
 * a < b, `0` if equal. Pre-release / build metadata is ignored — for
 * the "you're behind" prompt we only care about the major.minor.patch
 * triple. A non-semver string returns `0` (treat as up-to-date rather
 * than nag the user with a false positive).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const re = /^(\d+)\.(\d+)\.(\d+)/;
  const ma = re.exec(a);
  const mb = re.exec(b);
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const ai = Number.parseInt(ma[i]!, 10);
    const bi = Number.parseInt(mb[i]!, 10);
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

export async function checkLatestVersion(current: string): Promise<VersionCheckResult> {
  // 1. Cache hit within TTL → return immediately.
  const cached = await readCache();
  if (cached) {
    const age = Date.now() - new Date(cached.checkedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
      return {
        current,
        latestVersion: cached.latestVersion,
        isOutdated: compareVersions(cached.latestVersion, current) === 1,
        lastCheckedAt: cached.checkedAt,
        fromCache: true,
      };
    }
  }

  // 2. Otherwise fetch with a tight timeout. AbortController is the
  //    portable way to bound `fetch` in Node 22+.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let latest: string | null;
  try {
    latest = await fetchLatest(controller.signal);
  } finally {
    clearTimeout(timer);
  }

  if (latest === null) {
    // Network error — surface a partial result rather than throwing.
    // The caller (currently `kash version --check`) decides whether to
    // warn or just stay quiet.
    return {
      current,
      latestVersion: cached?.latestVersion ?? null,
      isOutdated: cached ? compareVersions(cached.latestVersion, current) === 1 : false,
      lastCheckedAt: cached?.checkedAt ?? null,
      fromCache: cached !== null,
    };
  }

  await writeCache(latest);
  return {
    current,
    latestVersion: latest,
    isOutdated: compareVersions(latest, current) === 1,
    lastCheckedAt: new Date().toISOString(),
    fromCache: false,
  };
}
