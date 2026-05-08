/**
 * Tests for the bare-invocation short-circuit at the top of
 * `index.ts`. Black-box because the logic lives in the entrypoint —
 * each test spawns the built binary and inspects stdout/stderr/exit.
 *
 * **Skipped when `dist/index.js` is not present.** Run `pnpm build`
 * first if you want these to execute. Most CI pipelines do that
 * before tests; locally use `pnpm test` (which the package script
 * pre-builds for) or `pnpm build && pnpm test:unit`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', '..', 'dist', 'index.js');
const distAvailable = existsSync(distEntry);

const describeIfDist = distAvailable ? describe : describe.skip;

describeIfDist('bare invocation', () => {
  function runKash(
    args: string[],
    env: NodeJS.ProcessEnv = {}
  ): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [distEntry, ...args], {
      env: {
        ...process.env,
        // Strip env vars that would interfere with the assertions
        // unless the test sets them explicitly.
        KASH_QUIET: undefined,
        KASH_DEBUG: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  }

  it('prints the curated landing in human mode', () => {
    const result = runKash([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kash');
    expect(result.stdout).toContain('kash setup');
    expect(result.stdout).toContain('Browse markets');
    expect(result.stdout).toContain('https://kash.bot/docs/cli');
  });

  it('emits the JSON envelope under --json', () => {
    const result = runKash(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as {
      name: string;
      version: string;
      suggestions: { command: string }[];
    };
    expect(json.name).toBe('kash');
    expect(typeof json.version).toBe('string');
    expect(json.suggestions.length).toBeGreaterThan(0);
  });

  it('emits NOTHING under --quiet (CI-friendly silent path)', () => {
    const result = runKash(['--quiet']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('honours KASH_QUIET=1 with the same silent-exit semantics', () => {
    const result = runKash([], { KASH_QUIET: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('honours KASH_QUIET=true / yes / on (case-insensitive)', () => {
    for (const value of ['true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
      const result = runKash([], { KASH_QUIET: value });
      expect(result.status, `KASH_QUIET=${value}`).toBe(0);
      expect(result.stdout, `KASH_QUIET=${value}`).toBe('');
    }
  });

  it('treats KASH_QUIET=0 / false / empty as off (intro renders)', () => {
    for (const value of ['', '0', 'false', 'no']) {
      const result = runKash([], { KASH_QUIET: value });
      expect(result.status, `KASH_QUIET=${JSON.stringify(value)}`).toBe(0);
      // Intro should still print under non-truthy env values.
      expect(result.stdout, `KASH_QUIET=${JSON.stringify(value)}`).toContain('Authenticate');
    }
  });

  it('--json wins over KASH_QUIET=1 (explicit > env)', () => {
    // Explicit `--json` is the user asking for structured output.
    // Honour it even when the env says quiet.
    const result = runKash(['--json'], { KASH_QUIET: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});
