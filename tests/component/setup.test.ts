/**
 * Component tests for `kash setup`.
 *
 * The wizard's interactive surface (`@inquirer/prompts`) is mocked at
 * the module boundary so tests run without a TTY. The persistent
 * config layer (`config-store`) and SDK client are mocked too — we
 * verify the orchestration: which functions get called, in what
 * order, and what JSON envelope is emitted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
}));

vi.mock('../../src/utils/config-store.js', () => ({
  updateConfig: vi.fn(),
  setCurrentProfile: vi.fn(),
}));

vi.mock('../../src/utils/client.js', () => ({
  buildClient: vi.fn(),
}));

const { input, confirm, password } = await import('@inquirer/prompts');
const { updateConfig, setCurrentProfile } = await import('../../src/utils/config-store.js');
const { buildClient } = await import('../../src/utils/client.js');
const { setupCommand } = await import('../../src/commands/setup.js');

const inputMock = vi.mocked(input);
const confirmMock = vi.mocked(confirm);
const passwordMock = vi.mocked(password);
const updateConfigMock = vi.mocked(updateConfig);
const setCurrentProfileMock = vi.mocked(setCurrentProfile);
const buildClientMock = vi.mocked(buildClient);

const VALID_KEY = 'kash_live_abcdefghijklmnopqrstuvwxyz123456';

function mockHealthOk(): { healthCheck: ReturnType<typeof vi.fn> } {
  const healthCheck = vi.fn().mockResolvedValue({
    ok: true,
    latencyMs: 42,
    status: 'ok',
    version: '1.2.0',
  });
  return { healthCheck };
}

describe('kash setup', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };
  let originalEnvKey: string | undefined;

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    inputMock.mockReset();
    confirmMock.mockReset();
    passwordMock.mockReset();
    updateConfigMock.mockReset();
    setCurrentProfileMock.mockReset();
    buildClientMock.mockReset();

    // Make sure tests don't accidentally pick up the developer's env.
    originalEnvKey = process.env['KASH_API_KEY'];
    delete process.env['KASH_API_KEY'];
  });

  afterEach(() => {
    teardown();
    if (originalEnvKey === undefined) {
      delete process.env['KASH_API_KEY'];
    } else {
      process.env['KASH_API_KEY'] = originalEnvKey;
    }
  });

  it('--api-key + --yes runs non-interactively and emits a JSON summary', async () => {
    updateConfigMock.mockResolvedValue({
      profile: 'default',
      stored: { apiKey: VALID_KEY },
    });
    setCurrentProfileMock.mockResolvedValue({
      version: 1,
      currentProfile: 'default',
      profiles: { default: { apiKey: VALID_KEY } },
    });
    buildClientMock.mockResolvedValue({
      client: mockHealthOk() as never,
      config: {} as never,
    });

    const { program, leafName } = wrapInProgram(setupCommand);
    await runViaProgram(program, leafName, ['--api-key', VALID_KEY, '--yes'], ['--json']);

    // No prompt should have fired.
    expect(inputMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();

    // Config layer called with the right key + profile.
    expect(updateConfigMock).toHaveBeenCalledWith({ apiKey: VALID_KEY }, { profile: 'default' });
    // Setup threads `globals.configPath` to setCurrentProfile (DX round 5
    // bug-fix: --config was being silently ignored). The second arg is
    // undefined when no --config flag was passed.
    expect(setCurrentProfileMock).toHaveBeenCalledWith('default', undefined);

    // JSON envelope shape.
    const json = parseJsonStdout(capture) as {
      ok: true;
      profile: string;
      authenticated: boolean;
      health: { ok: boolean; latencyMs: number };
      completionInstalled: boolean;
    };
    expect(json.ok).toBe(true);
    expect(json.profile).toBe('default');
    expect(json.authenticated).toBe(true);
    expect(json.health.ok).toBe(true);
    expect(json.health.latencyMs).toBe(42);
    // --yes skips the completion prompt entirely.
    expect(json.completionInstalled).toBe(false);
  });

  it('uses KASH_API_KEY from env when no --api-key flag is set', async () => {
    process.env['KASH_API_KEY'] = VALID_KEY;
    updateConfigMock.mockResolvedValue({
      profile: 'default',
      stored: { apiKey: VALID_KEY },
    });
    setCurrentProfileMock.mockResolvedValue({
      version: 1,
      currentProfile: 'default',
      profiles: { default: { apiKey: VALID_KEY } },
    });
    buildClientMock.mockResolvedValue({
      client: mockHealthOk() as never,
      config: {} as never,
    });

    const { program, leafName } = wrapInProgram(setupCommand);
    await runViaProgram(program, leafName, ['--yes'], ['--json']);

    expect(inputMock).not.toHaveBeenCalled();
    expect(updateConfigMock).toHaveBeenCalledWith({ apiKey: VALID_KEY }, { profile: 'default' });
  });

  it('--yes without an API key throws INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(setupCommand);
    await expect(runViaProgram(program, leafName, ['--yes'], ['--json'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    expect(inputMock).not.toHaveBeenCalled();
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('honours top-level --profile flag and writes to that profile', async () => {
    updateConfigMock.mockResolvedValue({
      profile: 'staging',
      stored: { apiKey: VALID_KEY },
    });
    setCurrentProfileMock.mockResolvedValue({
      version: 1,
      currentProfile: 'staging',
      profiles: { staging: { apiKey: VALID_KEY } },
    });
    buildClientMock.mockResolvedValue({
      client: mockHealthOk() as never,
      config: {} as never,
    });

    const { program, leafName } = wrapInProgram(setupCommand);
    // Top-level --profile must precede the leaf name (it's a global,
    // not a leaf option) — same shape as `kash --profile staging setup`.
    await runViaProgram(
      program,
      leafName,
      ['--api-key', VALID_KEY, '--yes'],
      ['--json', '--profile', 'staging']
    );

    expect(updateConfigMock).toHaveBeenCalledWith({ apiKey: VALID_KEY }, { profile: 'staging' });
    expect(setCurrentProfileMock).toHaveBeenCalledWith('staging', undefined);
    const json = parseJsonStdout(capture) as { profile: string };
    expect(json.profile).toBe('staging');
  });

  it('threads top-level --config <path> to both updateConfig and setCurrentProfile', async () => {
    // Regression: `kash setup --config /tmp/x.json --api-key … --yes`
    // used to silently ignore the global `--config` flag, writing to
    // ~/.kash/config.json regardless of intent. Pin that both write
    // calls now receive the override.
    updateConfigMock.mockResolvedValue({
      profile: 'default',
      stored: { apiKey: VALID_KEY },
    });
    setCurrentProfileMock.mockResolvedValue({
      version: 1,
      currentProfile: 'default',
      profiles: { default: { apiKey: VALID_KEY } },
    });
    buildClientMock.mockResolvedValue({
      client: mockHealthOk() as never,
      config: {} as never,
    });

    const { program, leafName } = wrapInProgram(setupCommand);
    await runViaProgram(
      program,
      leafName,
      ['--api-key', VALID_KEY, '--yes'],
      ['--json', '--config', '/tmp/test-config.json']
    );

    expect(updateConfigMock).toHaveBeenCalledWith(
      { apiKey: VALID_KEY },
      { profile: 'default', configPath: '/tmp/test-config.json' }
    );
    expect(setCurrentProfileMock).toHaveBeenCalledWith('default', {
      configPath: '/tmp/test-config.json',
    });
  });

  it('completes setup even when health check fails (warns, does not throw)', async () => {
    updateConfigMock.mockResolvedValue({
      profile: 'default',
      stored: { apiKey: VALID_KEY },
    });
    setCurrentProfileMock.mockResolvedValue({
      version: 1,
      currentProfile: 'default',
      profiles: { default: { apiKey: VALID_KEY } },
    });
    // Simulate a network outage during health check.
    const failingClient = {
      healthCheck: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    buildClientMock.mockResolvedValue({
      client: failingClient as never,
      config: {} as never,
    });

    const { program, leafName } = wrapInProgram(setupCommand);
    await runViaProgram(program, leafName, ['--api-key', VALID_KEY, '--yes'], ['--json']);

    // Setup still emitted a successful summary — config was saved.
    const json = parseJsonStdout(capture) as { ok: true; health: { ok: boolean } };
    expect(json.ok).toBe(true);
    expect(json.health.ok).toBe(false);
    // Config write must still have happened (the wizard's primary job).
    expect(updateConfigMock).toHaveBeenCalled();
  });
});
