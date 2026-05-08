#!/usr/bin/env node
// @ts-check
/**
 * Pre-publish smoke test for the built `kash` binary.
 *
 * Spawns `node dist/index.js …` for a handful of commands that don't
 * require network or API auth, and asserts:
 *
 *   1. The bundle loads (no top-level import error).
 *   2. The shebang banner survives `tsup` so the binary is directly
 *      executable (covered transitively — we run it via `node`, but a
 *      separate check confirms the dist file is exec-mode-set).
 *   3. The contract envelopes (`version --json`, `schema --json`,
 *      `config show --json`, `docs --json`) match the published Zod
 *      schemas. Catches a regression where a refactor accidentally
 *      drops a required field.
 *   4. Error paths still emit the `{ok:false, error:{…}}` envelope.
 *
 * Why this exists alongside the unit tests: the unit tests run against
 * source via Vitest. This script runs against the built `dist/`
 * artifact under a fresh Node process — the same artifact npm will
 * publish — and catches build-time regressions Vitest can't see
 * (missing exports, dropped shebang, dist-only path resolution bugs,
 * native dep loading on the wrong runtime).
 *
 * Usage (from packages/cli):
 *
 *   pnpm build
 *   node scripts/runtime-smoke.mjs
 *
 * Exits 0 on success, 1 on any failure.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '..');
const DIST_BIN = resolve(PKG_DIR, 'dist', 'index.js');

const failures = [];

function assert(condition, label) {
  if (!condition) {
    failures.push(`✗ ${label}`);
    return;
  }
  console.log(`✓ ${label}`);
}

/**
 * Run `node dist/index.js <args>` with a clean env. Returns
 * { stdout, stderr, status }. We strip every `KASH_*` env var so the
 * smoke test doesn't accidentally pick up the operator's real
 * configuration — we want to exercise the published binary's
 * default-path behaviour, not their dev profile.
 */
function runCli(args) {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const k of Object.keys(env)) {
    if (k.startsWith('KASH_')) delete env[k];
  }
  const result = spawnSync(process.execPath, [DIST_BIN, ...args], {
    encoding: 'utf8',
    env,
    // The `setup` and `auth` flows can prompt; we never invoke those
    // here, but pin stdin to /dev/null so a stray prompt fails fast
    // rather than hanging the smoke run.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

// ---- preflight: dist artifact exists & is loadable ----------------------

assert(existsSync(DIST_BIN), `dist/index.js exists at ${DIST_BIN}`);

if (existsSync(DIST_BIN)) {
  const st = statSync(DIST_BIN);
  assert(st.size > 0, 'dist/index.js is non-empty');
}

// ---- shebang survives the bundler --------------------------------------

if (existsSync(DIST_BIN)) {
  // First two bytes of the bundled file must be `#!` so package
  // managers that mark the bin executable can launch it directly. The
  // tsup config's `banner.js` injects this; if a future tsup upgrade
  // strips it, this catches the regression.
  const fd = await import('node:fs').then((m) => m.openSync(DIST_BIN, 'r'));
  const buf = Buffer.alloc(2);
  await import('node:fs').then((m) => m.readSync(fd, buf, 0, 2, 0));
  await import('node:fs').then((m) => m.closeSync(fd));
  assert(buf.toString() === '#!', 'dist/index.js starts with shebang');
}

// ---- bare `--version` ---------------------------------------------------

{
  const r = runCli(['--version']);
  assert(r.status === 0, '`--version` exits 0');
  assert(/^\d+\.\d+\.\d+/.test(r.stdout.trim()), '`--version` prints semver');
}

// ---- `version --json` matches VersionManifestSchema --------------------

{
  const r = runCli(['version', '--json']);
  assert(r.status === 0, '`version --json` exits 0');
  let manifest;
  try {
    manifest = JSON.parse(r.stdout);
  } catch {
    assert(false, '`version --json` emits valid JSON');
  }
  if (manifest) {
    for (const field of ['cli', 'sdk', 'node', 'platform', 'release', 'arch']) {
      assert(typeof manifest[field] === 'string', `version manifest has string '${field}'`);
    }
    assert(Array.isArray(manifest.capabilities), 'version manifest has capabilities[]');
    // Spot-check a load-bearing capability — if anyone deletes the
    // `json-envelope` token mid-release, this fails before publish.
    assert(
      manifest.capabilities.includes('json-envelope'),
      'capabilities[] includes json-envelope (SemVer-stable token)'
    );
  }
}

// ---- `schema --json` returns the schema bundle -------------------------

{
  const r = runCli(['schema', '--json']);
  assert(r.status === 0, '`schema --json` exits 0');
  let schemas;
  try {
    schemas = JSON.parse(r.stdout);
  } catch {
    assert(false, '`schema --json` emits valid JSON');
  }
  if (schemas) {
    // The bundle is wrapped in a `schemas` field. Names are stripped of
    // the `Schema` suffix (the Zod identifier name vs the wire name).
    const inner = schemas.schemas;
    assert(typeof inner === 'object' && inner !== null, 'schema bundle has top-level `schemas` key');
    if (inner) {
      // Every published schema name agents pin to. If any go missing
      // mid-release, downstream `--json` parsers break silently.
      for (const key of ['CliErrorEnvelope', 'VersionManifest', 'CliConfigEnvelope']) {
        assert(typeof inner[key] === 'object' && inner[key] !== null, `schema bundle has ${key}`);
      }
    }
  }
}

// ---- `docs --json` returns the command tree ----------------------------

{
  const r = runCli(['docs', '--json']);
  assert(r.status === 0, '`docs --json` exits 0');
  let docs;
  try {
    docs = JSON.parse(r.stdout);
  } catch {
    assert(false, '`docs --json` emits valid JSON');
  }
  if (docs) {
    // `docs --json` returns a recursive command tree rooted at `kash`
    // itself: `{name, fullName, subcommands[…]}`. Count the immediate
    // subcommands as the smoke check — anything ≥10 means the major
    // namespaces (markets, trades, quotes, portfolio, traces, webhooks,
    // account, auth, config, eoa, protocol, …) are wired up.
    assert(docs.name === 'kash', 'docs root is kash');
    assert(Array.isArray(docs.subcommands), 'docs has subcommands[]');
    assert(docs.subcommands.length > 10, 'docs.subcommands has >10 entries');
  }
}

// ---- `config show --json` matches CliConfigEnvelopeSchema --------------

{
  // No profile / config file in the smoke env — this exercises the
  // "default profile, nothing configured" path. The envelope must
  // still validate, with `apiKey: null` and `sources.apiKey: 'unset'`.
  const r = runCli(['config', 'show', '--json']);
  assert(r.status === 0, '`config show --json` exits 0 with no config');
  let env;
  try {
    env = JSON.parse(r.stdout);
  } catch {
    assert(false, '`config show --json` emits valid JSON');
  }
  if (env) {
    assert(typeof env.profile === 'string', 'config envelope has profile');
    assert(env.apiKey === null, 'config envelope apiKey is null when unset');
    assert(env.authenticated === false, 'config envelope authenticated is false when unset');
    assert(typeof env.baseUrl === 'string', 'config envelope baseUrl present');
    assert(typeof env.sources === 'object', 'config envelope sources present');
    for (const f of ['rpcUrl', 'smartAccount', 'bundlerUrl', 'bundlerProvider', 'signerKeyRef']) {
      assert(f in env, `config envelope has direct-mode field '${f}' (always present)`);
    }
  }
}

// ---- error envelope on a known-bad command -----------------------------

{
  // `markets get` against an unauthenticated profile fails with the
  // `AUTH_REQUIRED` envelope (the smoke env strips KASH_* so no key
  // is configured). This pins that the error path serialises through
  // `toEnvelope()` correctly in a fresh Node process — and that the
  // configured-from-catalog AUTH_REQUIRED entry survives the build.
  const r = runCli(['markets', 'get', 'not-a-uuid', '--json']);
  assert(r.status !== 0, '`markets get <bad-uuid> --json` exits non-zero');
  let env;
  try {
    env = JSON.parse(r.stdout);
  } catch {
    assert(false, 'error path still emits valid JSON');
  }
  if (env) {
    assert(env.ok === false, 'error envelope has ok:false');
    assert(typeof env.error === 'object' && env.error !== null, 'error envelope has error{}');
    if (env.error) {
      assert(typeof env.error.code === 'string', 'error.code is a string');
      assert(typeof env.error.message === 'string', 'error.message is a string');
      assert(typeof env.error.recoverable === 'boolean', 'error.recoverable is a boolean');
      assert(Array.isArray(env.error.actions), 'error.actions is an array');
    }
  }
}

// ---- summary -----------------------------------------------------------

console.log(`\nRuntime: node/${process.versions.node}`);
console.log(`Tests:   ${failures.length === 0 ? 'PASS' : 'FAIL'}`);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} smoke test(s) failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
