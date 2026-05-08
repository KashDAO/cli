/**
 * Smoke tests for the one-line installer (`scripts/install.sh`).
 *
 * The installer is the curl|sh entry point linked from the README, so a
 * regression here breaks first-impression onboarding. We exercise it in
 * `--dry-run` mode (no global package install) and assert:
 *
 *   1. Argument parsing for --pm / --version / unknown args works.
 *   2. Node version detection produces the correct command.
 *   3. The dry-run output names every command we expect to surface to
 *      the user (so a typo in the printed command line doesn't ship).
 *
 * The script itself is POSIX shell, executed via `sh`. We intentionally
 * do NOT mock `node` — the test runs against the same Node the project
 * uses, which is already >= 22.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../scripts/install.sh');

function run(args: readonly string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('sh', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('install.sh', () => {
  it('--help exits 0 and lists the supported options', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--version');
    expect(r.stdout).toContain('--pm');
    expect(r.stdout).toContain('--dry-run');
  });

  it('--dry-run with default PM picks pnpm/yarn/npm and prints a non-empty command', () => {
    const r = run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Detected:\s+node v\d+/);
    expect(r.stdout).toMatch(/Installing: @kashdao\/cli@latest via (pnpm|yarn|npm)/);
    expect(r.stdout).toMatch(
      /Command:\s+(pnpm add -g|yarn global add|npm install -g) @kashdao\/cli@latest/
    );
    expect(r.stdout).toContain('(dry run)');
  });

  it('--dry-run --pm npm --version 0.1.0 emits an exact npm command', () => {
    const r = run(['--dry-run', '--pm', 'npm', '--version', '0.1.0']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Command:    npm install -g @kashdao/cli@0.1.0');
  });

  it('--dry-run --pm pnpm uses pnpm add', () => {
    const r = run(['--dry-run', '--pm', 'pnpm', '--version', '1.2.3']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Command:    pnpm add -g @kashdao/cli@1.2.3');
  });

  it('--dry-run --pm yarn uses yarn global add', () => {
    const r = run(['--dry-run', '--pm', 'yarn', '--version', '0.2.0']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Command:    yarn global add @kashdao/cli@0.2.0');
  });

  it('--pm bogus exits 2 with a clear error', () => {
    const r = run(['--pm', 'bogus', '--dry-run']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unsupported --pm value: bogus');
  });

  it('unknown argument exits 2', () => {
    const r = run(['--definitely-not-a-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument');
  });
});
