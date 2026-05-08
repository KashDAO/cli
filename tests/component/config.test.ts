/**
 * Component tests for `kash config show / set / profiles / use`.
 *
 * Each test points the command at an isolated temp config via the
 * `--config <path>` flag so $HOME never gets touched.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { profilesCommand } from '../../src/commands/config/profiles.js';
import { setConfigCommand } from '../../src/commands/config/set.js';
import { showConfigCommand } from '../../src/commands/config/show.js';
import { useProfileCommand } from '../../src/commands/config/use.js';
import { setKeyCommand } from '../../src/commands/auth/set-key.js';
import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

function tmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'kash-cli-config-test-')), 'config.json');
}

const originalEnv = { ...process.env };

describe('kash config show', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    delete process.env['KASH_API_KEY'];
    delete process.env['KASH_PROFILE'];
    delete process.env['KASH_BASE_URL'];
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });
  afterEach(() => {
    teardown();
    process.env = { ...originalEnv };
  });

  it('reports defaults when the file is empty', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(showConfigCommand);
    await runViaProgram(program, leafName, [], ['--config', path, '--json']);

    const json = parseJsonStdout(capture) as {
      profile: string;
      baseUrl: string;
      sources: { profile: string };
    };
    expect(json.profile).toBe('default');
    expect(json.baseUrl).toBe('https://api.kash.bot/v1');
    expect(json.sources.profile).toBe('default');
  });
});

describe('kash config set', () => {
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

  it('sets baseUrl on the named profile', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(setConfigCommand);
    await runViaProgram(
      program,
      leafName,
      ['baseUrl', 'https://api-staging.kash.bot/v1'],
      ['--config', path, '--profile', 'staging', '--json']
    );

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      profiles: Record<string, { baseUrl?: string }>;
    };
    expect(onDisk.profiles['staging']!.baseUrl).toBe('https://api-staging.kash.bot/v1');
  });

  it('rejects an unknown key with INVALID_INPUT', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(setConfigCommand);
    await expect(
      runViaProgram(program, leafName, ['nope', 'value'], ['--config', path])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('parses defaultChainId as an integer', async () => {
    const path = tmpConfigPath();
    const { program, leafName } = wrapInProgram(setConfigCommand);
    await runViaProgram(program, leafName, ['defaultChainId', '84532'], ['--config', path]);

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      profiles: Record<string, { defaultChainId?: number }>;
    };
    expect(onDisk.profiles['default']!.defaultChainId).toBe(84532);
  });
});

describe('kash config profiles + use', () => {
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

  it('lists every profile and surfaces the active one', async () => {
    const path = tmpConfigPath();
    // Seed two profiles.
    const setProgram = wrapInProgram(setKeyCommand);
    await runViaProgram(
      setProgram.program,
      setProgram.leafName,
      ['kash_test_aaaaaaaaaaaaaaaaa'],
      ['--config', path, '--profile', 'staging']
    );
    await runViaProgram(
      setProgram.program,
      setProgram.leafName,
      ['kash_live_bbbbbbbbbbbbbbbbb'],
      ['--config', path, '--profile', 'prod']
    );

    capture.stdout = '';
    capture.stderr = '';

    const { program, leafName } = wrapInProgram(profilesCommand);
    await runViaProgram(program, leafName, [], ['--config', path, '--json']);
    const json = parseJsonStdout(capture) as { current: string; profiles: string[] };
    expect(json.profiles).toEqual(['prod', 'staging']);
    expect(json.current).toBe('default');
  });

  it('use writes currentProfile to disk', async () => {
    const path = tmpConfigPath();
    const setProgram = wrapInProgram(setKeyCommand);
    await runViaProgram(
      setProgram.program,
      setProgram.leafName,
      ['kash_live_bbbbbbbbbbbbbbbbb'],
      ['--config', path, '--profile', 'prod']
    );

    const useProgram = wrapInProgram(useProfileCommand);
    await runViaProgram(useProgram.program, useProgram.leafName, ['prod'], ['--config', path]);

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { currentProfile: string };
    expect(onDisk.currentProfile).toBe('prod');
  });
});
