/**
 * Component tests for `kash auth set-key / status / logout`.
 *
 * These commands read and write the on-disk config rather than calling
 * the SDK. We use `--config <tmp>` to point them at an isolated
 * temp file per test, sidestepping global state in $HOME.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { logoutCommand } from '../../src/commands/auth/logout.js';
import { setKeyCommand } from '../../src/commands/auth/set-key.js';
import { statusCommand } from '../../src/commands/auth/status.js';
import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

function tmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'kash-cli-auth-test-')), 'config.json');
}

const originalEnv = { ...process.env };

describe('kash auth set-key', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    delete process.env['KASH_API_KEY'];
    delete process.env['KASH_PROFILE'];
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });

  afterEach(() => {
    teardown();
    process.env = { ...originalEnv };
  });

  it('persists the key into the named profile and surfaces the redacted value as JSON', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(setKeyCommand);
    await runViaProgram(
      program,
      leafName,
      ['kash_test_aaaaaaaaaaaaaaaaa'],
      ['--config', path, '--profile', 'staging', '--json']
    );

    const json = parseJsonStdout(capture) as { ok: boolean; profile: string; apiKey: string };
    expect(json.ok).toBe(true);
    expect(json.profile).toBe('staging');
    expect(json.apiKey).toMatch(/^kash_tes\.\.\./);

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      profiles: Record<string, { apiKey: string }>;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.profiles['staging']!.apiKey).toBe('kash_test_aaaaaaaaaaaaaaaaa');
  });

  it('rejects a key without the kash_ prefix', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(setKeyCommand);
    await expect(
      runViaProgram(program, leafName, ['sk-live-foo'], ['--config', path])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  // Mutual-exclusion guard: pre-fix, the positional silently won
  // and the piped value was dropped. Real footgun on a real-money
  // path — the operator sees "API key saved" for the WRONG key.
  it('refuses both positional <key> AND --from-stdin together', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(setKeyCommand);
    await expect(
      runViaProgram(
        program,
        leafName,
        ['kash_live_aaaaaaaaaaaaaaaaa', '--from-stdin'],
        ['--config', path]
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('kash auth status', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    delete process.env['KASH_API_KEY'];
    delete process.env['KASH_PROFILE'];
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });

  afterEach(() => {
    teardown();
    process.env = { ...originalEnv };
  });

  it('reports unauthenticated when no key is configured', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(statusCommand);
    await runViaProgram(program, leafName, [], ['--config', path, '--json']);

    const json = parseJsonStdout(capture) as { authenticated: boolean; profile: string };
    expect(json.authenticated).toBe(false);
    expect(json.profile).toBe('default');
  });

  it('reports KASH_API_KEY env source when env var is set', async () => {
    const path = tmpConfigPath();
    process.env['KASH_API_KEY'] = 'kash_env_abcdefghijkl';

    const { program, leafName } = wrapInProgram(statusCommand);
    await runViaProgram(program, leafName, [], ['--config', path, '--json']);

    const json = parseJsonStdout(capture) as {
      authenticated: boolean;
      sources: { apiKey: string };
    };
    expect(json.authenticated).toBe(true);
    expect(json.sources.apiKey).toBe('env');
  });
});

describe('kash auth logout', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    delete process.env['KASH_API_KEY'];
    delete process.env['KASH_PROFILE'];
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });

  afterEach(() => {
    teardown();
    process.env = { ...originalEnv };
  });

  it('clears the apiKey from the named profile', async () => {
    const path = tmpConfigPath();
    // Pre-populate via set-key.
    const setProgram = wrapInProgram(setKeyCommand);
    await runViaProgram(
      setProgram.program,
      setProgram.leafName,
      ['kash_test_xxxxxxxxxxxxxxxxx'],
      ['--config', path, '--profile', 'staging']
    );

    // Reset capture for the logout invocation.
    capture.stdout = '';
    capture.stderr = '';

    const { program, leafName } = wrapInProgram(logoutCommand);
    await runViaProgram(
      program,
      leafName,
      [],
      ['--config', path, '--profile', 'staging', '--json']
    );

    const json = parseJsonStdout(capture) as { ok: boolean; cleared: boolean; profile: string };
    expect(json.ok).toBe(true);
    expect(json.cleared).toBe(true);
    expect(json.profile).toBe('staging');

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      profiles: Record<string, { apiKey?: string }>;
    };
    expect(onDisk.profiles['staging']?.apiKey).toBeUndefined();
  });
});
