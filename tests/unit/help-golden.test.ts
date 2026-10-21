/**
 * Help-output golden / snapshot tests.
 *
 * Spawns the built binary and asserts the structural shape of
 * `kash --help` and a representative subset of subcommand `--help`
 * pages. These are inline snapshots — when help text changes, the
 * test prints the diff and a one-line edit (or `pnpm test -u`)
 * accepts the new shape.
 *
 * Goal: catch accidental flag removals, description regressions, or
 * subcommand renames that no other test would notice. Help text is
 * a stability surface for shell completion, AI agents, and shell
 * tutorials — silent drift here is bad UX.
 *
 * **Skipped when `dist/index.js` is not present.** Run `pnpm build`
 * first; the package's `pnpm test` script pre-builds.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', '..', 'dist', 'index.js');
const distAvailable = existsSync(distEntry);

const describeIfDist = distAvailable ? describe : describe.skip;

function runKash(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [distEntry, ...args], {
    env: {
      ...process.env,
      KASH_QUIET: undefined,
      KASH_DEBUG: undefined,
      // `NO_COLOR` is the canonical "no ANSI escapes" toggle and the
      // CLI honours it. Snapshots that ignore color are dramatically
      // easier to maintain.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    } as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describeIfDist('help output (golden)', () => {
  it('top-level `kash --help` lists every documented command group', () => {
    const result = runKash(['--help']);
    expect(result.status).toBe(0);
    // Anchor on stable strings rather than full-text snapshot — the
    // commander-rendered layout has trailing-space drift between
    // versions but the command names + descriptions are stable.
    const out = result.stdout;
    // Top-level groups (one anchor each — drift in any of these is a
    // breaking change for tab-completion + agent surfaces).
    for (const cmd of [
      'auth',
      'config',
      'docs',
      'explain',
      'health',
      'markets',
      'portfolio',
      'quote',
      'schema',
      'setup',
      'trace',
      'trade',
      'version',
      'webhooks',
      'with-retry',
    ]) {
      expect(out, `--help is missing the '${cmd}' command`).toMatch(
        new RegExp(`(?:^|\\s)${cmd}\\s`, 'm')
      );
    }
    // Global flags must remain documented.
    for (const flag of [
      '--json',
      '--quiet',
      '--no-color',
      '--debug',
      '--profile',
      '--config',
      '--base-url',
      '--max-retries',
      '--timeout-ms',
      '--api-version',
      '--fields',
      '--filter',
    ]) {
      expect(out, `--help is missing the '${flag}' global flag`).toContain(flag);
    }
  });

  it('`kash --version` prints exactly the version, no extra noise', () => {
    const result = runKash(['--version']);
    expect(result.status).toBe(0);
    // Single semver line, optional pre-release. Trailing newline OK.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
    expect(result.stderr).toBe('');
  });

  it('`kash trade --help` exposes the `buy`, `sell`, `confirm`, `list`, `status` subcommands', () => {
    const result = runKash(['trade', '--help']);
    expect(result.status).toBe(0);
    for (const sub of ['buy', 'sell', 'confirm', 'list', 'status']) {
      expect(result.stdout).toMatch(new RegExp(`(?:^|\\s)${sub}\\s`, 'm'));
    }
  });

  it('`kash markets --help` exposes the `list`, `get`, `predictions` subcommands', () => {
    const result = runKash(['markets', '--help']);
    expect(result.status).toBe(0);
    for (const sub of ['list', 'get', 'predictions']) {
      expect(result.stdout).toMatch(new RegExp(`(?:^|\\s)${sub}\\s`, 'm'));
    }
  });

  it('top-level help names no retired command group and no retired chain', () => {
    const result = runKash(['--help']);
    expect(result.status).toBe(0);
    const out = result.stdout;
    // The positive control: the same page names a group that exists.
    expect(out).toMatch(/^\s+markets\b/m);
    // `kash protocol` / `kash eoa` were removed in 0.3.0.
    expect(out).not.toMatch(/^\s+(protocol|eoa)\b/m);
    // Every "Common workflows" command must exist: `kash su` never did.
    expect(out).toContain('kash config use <name>');
    expect(out).not.toContain('kash su ');
    expect(out).not.toMatch(/\bBase\b|Sepolia/);
  });

  it('the retired command groups are unknown commands', () => {
    for (const group of ['protocol', 'eoa']) {
      // `--help` would fall through to the root help, so name a subcommand.
      const result = runKash([group, 'balance']);
      expect(result.status).not.toBe(0);
      expect((result.stderr + result.stdout).toLowerCase()).toMatch(/unknown command/);
    }
  });

  it('`kash docs --help` advertises the `--json` agent-discovery mode', () => {
    const result = runKash(['docs', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--json');
  });

  it('a non-existent subcommand exits non-zero with a helpful suggestion', () => {
    const result = runKash(['markets', 'totally-not-a-real-subcommand']);
    expect(result.status).not.toBe(0);
    // Commander prints the unknown-subcommand error to stderr.
    const combined = result.stderr + result.stdout;
    expect(combined.toLowerCase()).toMatch(/unknown command|invalid|error/);
  });
});
