/**
 * CLI README KASH_* env-var references ↔ source-side reads.
 *
 * The README documents a customer-facing set of environment
 * variables — KASH_API_KEY, KASH_PROFILE, KASH_BASE_URL, etc. Each
 * one MUST correspond to a real env var the CLI reads, otherwise
 * customer setup (`export KASH_API_KEY=...`) silently does nothing.
 *
 * Forward direction only (README → source). The inverse — every env
 * var the CLI reads must be in the README — is intentionally not
 * pinned because some env vars are debug/CI affordances
 * (KASH_NO_UPDATE_CHECK, KASH_QUIET) that the public-facing README
 * deliberately omits.
 *
 * Catches the most likely real-world drift: a README typo like
 * `KASH_API_KY` (which "looks right" but is silently ignored) or a
 * rename where source was updated but README wasn't.
 *
 * Same drift class as round AY (CLI README ↔ src/index.ts addCommand)
 * and AZ (admin-CLI README ↔ src/index.ts addCommand), applied to
 * env-var configuration.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const README = readFileSync(resolve(packageRoot, 'README.md'), 'utf8');

/**
 * Walk every .ts file under src/ and pull every `KASH_<X>` token
 * that follows a `process.env` access pattern. The exact patterns
 * supported:
 *
 *   process.env.KASH_FOO        — direct property access
 *   process.env['KASH_FOO']     — bracket access
 *   process.env["KASH_FOO"]     — bracket access with double quotes
 *
 * Any other shape (e.g. dynamic indexing, computed property names)
 * won't be picked up — those are rare and intentionally excluded.
 */
function loadSourceEnvVars(): Set<string> {
  const root = resolve(packageRoot, 'src');
  const out = new Set<string>();
  const RE = /process\.env(?:\.|\[\s*["'])(KASH_[A-Z_]+)/g;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(RE)) {
        out.add(m[1]!);
      }
    }
  }
  walk(root);
  return out;
}

const SOURCE_ENV_VARS = loadSourceEnvVars();

/**
 * Extract every KASH_<X> token mentioned in the README. Casts a
 * wide net — env vars are mentioned across code-fence examples
 * (`export KASH_API_KEY=…`), prose (`KASH_PROFILE is read…`), and
 * tables. Anything matching the literal pattern counts.
 */
function extractReadmeEnvVars(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bKASH_[A-Z_]+\b/g)) {
    out.add(m[0]);
  }
  return out;
}

const README_ENV_VARS = extractReadmeEnvVars(README);

describe('packages/cli/README.md ↔ src/ KASH_* env-var drift', () => {
  it('sanity floor: source reads at least the load-bearing env vars', () => {
    for (const required of ['KASH_API_KEY', 'KASH_PROFILE', 'KASH_BASE_URL'] as const) {
      expect(
        SOURCE_ENV_VARS.has(required),
        `CLI source must read ${required}. Currently reads: ${[...SOURCE_ENV_VARS].sort().join(', ')}.`
      ).toBe(true);
    }
  });

  it('sanity floor: README mentions at least the load-bearing env vars', () => {
    for (const required of ['KASH_API_KEY', 'KASH_PROFILE'] as const) {
      expect(
        README_ENV_VARS.has(required),
        `README must mention ${required} as a configurable env var.`
      ).toBe(true);
    }
  });

  it.each([...README_ENV_VARS].sort().map((v) => [v] as const))(
    'README mentions "%s" — that env var is actually read by the CLI',
    (envVar) => {
      // A typo in the README (e.g. `KASH_API_KY` vs `KASH_API_KEY`)
      // would have the customer `export KASH_API_KY=…` silently no-op.
      // This catches typos and stale env-var names from past renames.
      expect(
        SOURCE_ENV_VARS.has(envVar),
        `README mentions "${envVar}" but no CLI source file reads it. ` +
          `Either fix the README, or add the env-var read in src/. ` +
          `Currently read: ${[...SOURCE_ENV_VARS].sort().join(', ')}.`
      ).toBe(true);
    }
  );

  // Belt-and-braces: also call out the known undocumented operator
  // affordances explicitly. If a future README does decide to
  // document one of them, the test will still pass — this is
  // informational, asserting only that the source still reads them
  // (so they remain valid customer-side knobs even when undocumented).
  it.each(['KASH_NO_UPDATE_CHECK', 'KASH_QUIET'].map((v) => [v] as const))(
    'undocumented operator affordance "%s" is still read by the source',
    (envVar) => {
      expect(
        SOURCE_ENV_VARS.has(envVar),
        `${envVar} is an intentionally-undocumented CI/operator affordance. ` +
          `If the source stopped reading it, customers' CI scripts that set it break silently.`
      ).toBe(true);
    }
  );
});
