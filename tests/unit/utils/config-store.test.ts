/**
 * Config-store tests cover the most security-sensitive part of the
 * CLI: persisting API keys to disk. Each test uses an isolated temp
 * file (no global state), exercises the file/env precedence rules,
 * and asserts perms land at 0600 on POSIX.
 *
 * Multi-profile support adds three new test concerns:
 *   - profile resolution order (flag > env > file > default)
 *   - legacy flat-shape migration (silently upgraded to v1 default)
 *   - cross-profile isolation (writes to "test" don't touch "default")
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliConfigurationError } from '../../../src/errors.js';
import {
  DEFAULTS,
  clearConfigField,
  deleteConfig,
  deleteProfile,
  listProfiles,
  readConfig,
  setCurrentProfile,
  updateConfig,
} from '../../../src/utils/config-store.js';

function makeTempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kash-cli-test-'));
  return join(dir, 'config.json');
}

describe('config-store', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['KASH_API_KEY'];
    delete process.env['KASH_BASE_URL'];
    delete process.env['KASH_API_VERSION'];
    delete process.env['KASH_PROFILE'];
    delete process.env['KASH_CONFIG'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('basic resolution', () => {
    it('returns defaults when no file or env present', async () => {
      const configPath = makeTempConfigPath();
      const config = await readConfig({ configPath });
      expect(config.apiKey).toBeUndefined();
      expect(config.baseUrl).toBe(DEFAULTS.baseUrl);
      expect(config.apiVersion).toBe('2026-08-19');
      expect(config.profile).toBe('default');
      expect(config.sources.apiKey).toBe('unset');
      expect(config.sources.baseUrl).toBe('default');
      expect(config.sources.apiVersion).toBe('default');
      expect(config.sources.profile).toBe('default');
    });

    it('persists a key with mode 0600 and reads it back', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_abc123def456' }, { configPath });

      const config = await readConfig({ configPath });
      expect(config.apiKey).toBe('kash_test_abc123def456');
      expect(config.sources.apiKey).toBe('file');

      if (process.platform !== 'win32') {
        const mode = statSync(configPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('env vars take precedence over file values', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig(
        { apiKey: 'kash_file_keykeykey', baseUrl: 'https://file.example/v1' },
        { configPath }
      );

      process.env['KASH_API_KEY'] = 'kash_env_keykeykey';
      process.env['KASH_BASE_URL'] = 'https://env.example/v1';
      process.env['KASH_API_VERSION'] = '2026-04-29';

      const config = await readConfig({ configPath });
      expect(config.apiKey).toBe('kash_env_keykeykey');
      expect(config.baseUrl).toBe('https://env.example/v1');
      expect(config.apiVersion).toBe('2026-04-29');
      expect(config.sources.apiKey).toBe('env');
      expect(config.sources.baseUrl).toBe('env');
      expect(config.sources.apiVersion).toBe('env');
    });

    it('rejects a malformed KASH_API_VERSION', async () => {
      const configPath = makeTempConfigPath();
      process.env['KASH_API_VERSION'] = '26-08-19';
      await expect(readConfig({ configPath })).rejects.toBeInstanceOf(CliConfigurationError);
    });

    it('reads a per-profile apiVersion', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiVersion: '2026-04-29' }, { configPath });

      const config = await readConfig({ configPath });
      expect(config.apiVersion).toBe('2026-04-29');
      expect(config.sources.apiVersion).toBe('file');
    });

    it('no longer reads KASH_CHAIN or KASH_CHAIN_ID', async () => {
      const configPath = makeTempConfigPath();
      process.env['KASH_CHAIN'] = 'solana:devnet';
      process.env['KASH_CHAIN_ID'] = '8453';
      const config = await readConfig({ configPath });
      expect(config.apiVersion).toBe('2026-08-19');
      expect(config).not.toHaveProperty('defaultChain');
      expect(config.sources).not.toHaveProperty('defaultChain');
    });

    it('rejects an api key without the kash_ prefix when persisting', async () => {
      const configPath = makeTempConfigPath();
      await expect(updateConfig({ apiKey: 'sk-live-abc' }, { configPath })).rejects.toThrow();
    });

    it('clearConfigField removes only the targeted field', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig(
        { apiKey: 'kash_test_abc123def456', baseUrl: 'https://api.example/v1' },
        { configPath }
      );

      await clearConfigField('apiKey', { configPath });
      const config = await readConfig({ configPath });
      expect(config.apiKey).toBeUndefined();
      expect(config.baseUrl).toBe('https://api.example/v1');
    });

    it('rejects garbage JSON in the config file', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_abc123def456' }, { configPath });

      writeFileSync(configPath, '{ this is not json', 'utf8');

      await expect(readConfig({ configPath })).rejects.toBeInstanceOf(CliConfigurationError);
    });

    it('deleteConfig removes the file', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_abc123def456' }, { configPath });
      expect(readFileSync(configPath, 'utf8')).toContain('kash_test');

      await deleteConfig({ configPath });
      expect(() => readFileSync(configPath, 'utf8')).toThrow();
    });
  });

  describe('profile resolution', () => {
    it('writes to the named profile and reads it back', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_default_keys' }, { configPath, profile: 'default' });
      await updateConfig({ apiKey: 'kash_test_staging_key' }, { configPath, profile: 'staging' });

      const def = await readConfig({ configPath, profile: 'default' });
      const stg = await readConfig({ configPath, profile: 'staging' });
      expect(def.apiKey).toBe('kash_test_default_keys');
      expect(stg.apiKey).toBe('kash_test_staging_key');
    });

    it('--profile flag wins over KASH_PROFILE env', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_aaaaaaaaaaaa' }, { configPath, profile: 'a' });
      await updateConfig({ apiKey: 'kash_test_bbbbbbbbbbbb' }, { configPath, profile: 'b' });
      process.env['KASH_PROFILE'] = 'a';

      const config = await readConfig({ configPath, profile: 'b' });
      expect(config.apiKey).toBe('kash_test_bbbbbbbbbbbb');
      expect(config.profile).toBe('b');
      expect(config.sources.profile).toBe('flag');
    });

    it('KASH_PROFILE env wins over the file currentProfile', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_fileactivekey' }, { configPath, profile: 'file' });
      await setCurrentProfile('file', { configPath });
      await updateConfig({ apiKey: 'kash_test_envactivekeys' }, { configPath, profile: 'env' });
      process.env['KASH_PROFILE'] = 'env';

      const config = await readConfig({ configPath });
      expect(config.profile).toBe('env');
      expect(config.sources.profile).toBe('env');
      expect(config.apiKey).toBe('kash_test_envactivekeys');
    });

    it('asking for an unknown profile returns defaults but still names it', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_default_keys' }, { configPath });

      // KASH_QUIET silences the typo-warning that resolveActive
      // emits on an unknown --profile / KASH_PROFILE name; the test
      // intentionally exercises the "named-but-missing" path so we
      // mute the warn to keep test output clean.
      const previous = process.env['KASH_QUIET'];
      process.env['KASH_QUIET'] = '1';
      try {
        const config = await readConfig({ configPath, profile: 'never-created' });
        expect(config.profile).toBe('never-created');
        expect(config.apiKey).toBeUndefined();
        expect(config.sources.apiKey).toBe('unset');
      } finally {
        if (previous === undefined) delete process.env['KASH_QUIET'];
        else process.env['KASH_QUIET'] = previous;
      }
    });

    it('emits a stderr warning when the named profile is not in the file (typo guard)', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_default_keys' }, { configPath });

      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      };
      try {
        await readConfig({ configPath, profile: 'staing' });
      } finally {
        process.stderr.write = originalWrite;
      }
      const stderr = stderrChunks.join('');
      expect(stderr).toContain('Profile "staing"');
      expect(stderr).toContain('--profile');
      // Lists known profiles so a typo is obvious.
      expect(stderr).toContain('default');
    });

    it('listProfiles surfaces every profile and the current one', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_aaaaaaaaaaaa' }, { configPath, profile: 'a' });
      await updateConfig({ apiKey: 'kash_test_bbbbbbbbbbbb' }, { configPath, profile: 'b' });
      await setCurrentProfile('b', { configPath });

      const result = await listProfiles({ configPath });
      expect(result.current).toBe('b');
      expect(result.profiles).toEqual(['a', 'b']);
    });

    it('deleteProfile refuses to delete the active profile', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_active_keykey' }, { configPath, profile: 'active' });
      await setCurrentProfile('active', { configPath });

      await expect(deleteProfile('active', { configPath })).rejects.toBeInstanceOf(
        CliConfigurationError
      );
    });

    it('deleteProfile removes a non-active profile', async () => {
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_aaaaaaaaaaaa' }, { configPath, profile: 'a' });
      await updateConfig({ apiKey: 'kash_test_bbbbbbbbbbbb' }, { configPath, profile: 'b' });
      await setCurrentProfile('a', { configPath });

      await deleteProfile('b', { configPath });
      const result = await listProfiles({ configPath });
      expect(result.profiles).toEqual(['a']);
    });

    it('rejects invalid profile names', async () => {
      const configPath = makeTempConfigPath();
      await expect(
        updateConfig({ apiKey: 'kash_test_keykeykeykey' }, { configPath, profile: 'has spaces' })
      ).rejects.toThrow();
      await expect(
        updateConfig({ apiKey: 'kash_test_keykeykeykey' }, { configPath, profile: '' })
      ).rejects.toThrow();
    });
  });

  describe('legacy flat-shape migration', () => {
    it('reads a flat-shape file as the default profile', async () => {
      const configPath = makeTempConfigPath();
      // Hand-craft an old-style file to simulate an upgrade path.
      writeFileSync(
        configPath,
        JSON.stringify({
          apiKey: 'kash_legacy_aaaaaaaa',
          baseUrl: 'https://legacy.example/v1',
        }),
        'utf8'
      );

      const config = await readConfig({ configPath });
      expect(config.profile).toBe('default');
      expect(config.apiKey).toBe('kash_legacy_aaaaaaaa');
      expect(config.baseUrl).toBe('https://legacy.example/v1');
    });

    it('persists the v1 shape on the next write', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(configPath, JSON.stringify({ apiKey: 'kash_legacy_aaaaaaaa' }), 'utf8');

      await updateConfig({ baseUrl: 'https://new.example/v1' }, { configPath });

      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(raw['version']).toBe(1);
      expect(raw['profiles']).toBeDefined();
    });
  });

  describe('retired chain field migration', () => {
    it('reads a v1 profile still carrying defaultChainId or defaultChain', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          currentProfile: 'default',
          profiles: {
            default: { apiKey: 'kash_live_aaaaaaaaaaaa', defaultChainId: 8453 },
            staging: { defaultChain: 'solana:devnet' },
          },
        }),
        'utf8'
      );

      const config = await readConfig({ configPath });
      expect(config.apiKey).toBe('kash_live_aaaaaaaaaaaa');
      expect(config).not.toHaveProperty('defaultChain');

      const staging = await readConfig({ configPath, profile: 'staging' });
      expect(staging).not.toHaveProperty('defaultChain');
    });

    it('migrates a legacy flat-shape file carrying defaultChainId', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(
        configPath,
        JSON.stringify({ apiKey: 'kash_legacy_aaaaaaaa', defaultChainId: 8453 }),
        'utf8'
      );

      const config = await readConfig({ configPath });
      expect(config.apiKey).toBe('kash_legacy_aaaaaaaa');
    });

    it('drops both chain fields from the file on the next write', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          profiles: { default: { defaultChain: 'solana:devnet', defaultChainId: 8453 } },
        }),
        'utf8'
      );

      await updateConfig({ apiVersion: '2026-08-19' }, { configPath });

      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      expect(raw.profiles['default']).toEqual({ apiVersion: '2026-08-19' });
    });

    it('refuses to set defaultChain', async () => {
      const configPath = makeTempConfigPath();
      await expect(
        updateConfig({ defaultChain: 'solana:devnet' } as never, { configPath })
      ).rejects.toThrow();
    });
  });

  describe('0.2.x direct-mode field migration', () => {
    const RETIRED = {
      rpcUrl: 'https://rpc.example.com',
      smartAccount: '0xfedcba0987654321fedcba0987654321fedcba09',
      bundlerUrl: 'https://bundler.example.com',
      bundlerProvider: 'flashbots',
      signerKeyRef: 'env:SIGNER_KEY',
      customChain: { name: 'Anvil local' },
    };

    it('reads a profile still carrying the retired fields instead of refusing the file', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          profiles: { default: { apiKey: 'kash_live_aaaaaaaaaaaa', ...RETIRED } },
        }),
        'utf8'
      );

      const config = await readConfig({ configPath });
      expect(config.apiKey).toBe('kash_live_aaaaaaaaaaaa');
      for (const field of Object.keys(RETIRED)) {
        expect(config).not.toHaveProperty(field);
      }
    });

    it('drops the retired fields from the file on the next write', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(
        configPath,
        JSON.stringify({ version: 1, profiles: { default: { ...RETIRED } } }),
        'utf8'
      );

      await updateConfig({ apiVersion: '2026-08-19' }, { configPath });

      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      expect(raw.profiles['default']).toEqual({ apiVersion: '2026-08-19' });
    });

    it('still refuses an unknown field — only the retired ones are dropped', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(
        configPath,
        JSON.stringify({ version: 1, profiles: { default: { rpcUrll: 'https://x.example' } } }),
        'utf8'
      );

      await expect(readConfig({ configPath })).rejects.toThrow(/invalid/);
    });

    it('refuses to set a retired field', async () => {
      const configPath = makeTempConfigPath();
      await expect(
        updateConfig({ rpcUrl: 'https://rpc.example.com' } as never, { configPath })
      ).rejects.toThrow();
    });
  });

  describe('KASH_CONFIG env var', () => {
    it('routes readConfig to the env-supplied path when no explicit configPath is given', async () => {
      // Pre-populate a config at a path the caller does NOT pass to
      // readConfig — the only thing pointing there is the env var.
      const configPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_envrouterouting' }, { configPath });

      process.env['KASH_CONFIG'] = configPath;
      const config = await readConfig({});
      expect(config.apiKey).toBe('kash_test_envrouterouting');
      expect(config.sources.apiKey).toBe('file');
    });

    it('explicit configPath wins over KASH_CONFIG', async () => {
      const envPath = makeTempConfigPath();
      const explicitPath = makeTempConfigPath();
      await updateConfig({ apiKey: 'kash_test_envenvenvenvenv' }, { configPath: envPath });
      await updateConfig({ apiKey: 'kash_test_explicitexplicit' }, { configPath: explicitPath });
      process.env['KASH_CONFIG'] = envPath;

      const config = await readConfig({ configPath: explicitPath });
      expect(config.apiKey).toBe('kash_test_explicitexplicit');
    });
  });

  describe('non-object JSON guard', () => {
    it('rejects a top-level string with a friendly error', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(configPath, JSON.stringify('hello'), 'utf8');
      await expect(readConfig({ configPath })).rejects.toThrow(/JSON object at the top level/);
    });

    it('rejects a top-level array', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(configPath, JSON.stringify([1, 2, 3]), 'utf8');
      await expect(readConfig({ configPath })).rejects.toThrow(/JSON object at the top level/);
    });

    it('rejects a top-level null', async () => {
      const configPath = makeTempConfigPath();
      writeFileSync(configPath, 'null', 'utf8');
      await expect(readConfig({ configPath })).rejects.toThrow(/JSON object at the top level/);
    });
  });

  describe('malformed KASH_PROFILE produces typed CliConfigurationError', () => {
    it('rejects KASH_PROFILE with disallowed characters', async () => {
      const configPath = makeTempConfigPath();
      process.env['KASH_PROFILE'] = 'has spaces';
      await expect(readConfig({ configPath })).rejects.toBeInstanceOf(CliConfigurationError);
    });
  });
});
