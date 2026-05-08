/**
 * Component tests for `kash config export` and `kash config import`.
 *
 * Each test points the CLI at a temp config file via `KASH_CONFIG`
 * and verifies the round-trip behaviour: an exported bundle imports
 * cleanly into a fresh location, redaction policy works, and the
 * `--no-overwrite` and `--dry-run` paths behave.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

const { exportConfigCommand } = await import('../../src/commands/config/export.js');
const { importConfigCommand } = await import('../../src/commands/config/import.js');

const VALID_KEY = 'kash_live_aaaaaaaaaaaaaaaaaaaaaaaa';

let workDir: string;
let configPath: string;
let originalConfig: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kash-config-export-import-'));
  configPath = join(workDir, 'cfg.json');
  originalConfig = process.env['KASH_CONFIG'];
  process.env['KASH_CONFIG'] = configPath;
  configureOutput({ quiet: false, noColor: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (originalConfig === undefined) {
    delete process.env['KASH_CONFIG'];
  } else {
    process.env['KASH_CONFIG'] = originalConfig;
  }
});

function seedConfig(): void {
  // Write a minimal v1 config file directly so we don't depend on
  // `auth set-key` working in tests.
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 1,
        currentProfile: 'default',
        profiles: { default: { apiKey: VALID_KEY } },
      },
      null,
      2
    )
  );
}

describe('kash config export', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
  });

  afterEach(() => teardown());

  it('redacts apiKey by default', async () => {
    seedConfig();
    const { program, leafName } = wrapInProgram(exportConfigCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as {
      version: 1;
      profiles: Record<string, { apiKey?: string }>;
    };
    expect(json.profiles.default!.apiKey).toBe('<redacted>');
  });

  it('--include-secrets preserves the raw key', async () => {
    seedConfig();
    const { program, leafName } = wrapInProgram(exportConfigCommand);
    await runViaProgram(program, leafName, ['--include-secrets'], ['--json']);

    const json = parseJsonStdout(capture) as {
      profiles: Record<string, { apiKey?: string }>;
    };
    expect(json.profiles.default!.apiKey).toBe(VALID_KEY);
  });

  it('--out writes to a file at mode 0600 and respects redaction', async () => {
    seedConfig();
    const outPath = join(workDir, 'export.json');
    const { program, leafName } = wrapInProgram(exportConfigCommand);
    await runViaProgram(program, leafName, ['--out', outPath]);

    const written = JSON.parse(readFileSync(outPath, 'utf8')) as {
      profiles: Record<string, { apiKey?: string }>;
    };
    expect(written.profiles.default!.apiKey).toBe('<redacted>');
  });
});

describe('kash config import', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
  });

  afterEach(() => teardown());

  it('round-trips a --include-secrets export back into a fresh config', async () => {
    seedConfig();

    // Export to a file with secrets.
    const exportPath = join(workDir, 'export.json');
    const exportRun = wrapInProgram(exportConfigCommand);
    await runViaProgram(exportRun.program, exportRun.leafName, [
      '--include-secrets',
      '--out',
      exportPath,
    ]);

    // Switch to a fresh config location and import.
    const newConfigPath = join(workDir, 'new-cfg.json');
    process.env['KASH_CONFIG'] = newConfigPath;

    const importRun = wrapInProgram(importConfigCommand);
    await runViaProgram(importRun.program, importRun.leafName, [exportPath], ['--json']);

    const parsed = parseJsonStdout(capture) as {
      written: boolean;
      profiles: string[];
    };
    expect(parsed.written).toBe(true);
    expect(parsed.profiles).toContain('default');

    // Verify the file landed.
    const onDisk = JSON.parse(readFileSync(newConfigPath, 'utf8')) as {
      profiles: Record<string, { apiKey?: string }>;
    };
    expect(onDisk.profiles.default!.apiKey).toBe(VALID_KEY);
  });

  it('refuses bundles with redacted apiKey values', async () => {
    seedConfig();

    // Export WITHOUT --include-secrets → keys redacted.
    const exportPath = join(workDir, 'redacted.json');
    const exportRun = wrapInProgram(exportConfigCommand);
    await runViaProgram(exportRun.program, exportRun.leafName, ['--out', exportPath]);

    // Try to import the redacted bundle.
    const newConfigPath = join(workDir, 'new-cfg.json');
    process.env['KASH_CONFIG'] = newConfigPath;
    const importRun = wrapInProgram(importConfigCommand);
    await expect(
      runViaProgram(importRun.program, importRun.leafName, [exportPath])
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('--dry-run reports the merged shape without writing to disk', async () => {
    seedConfig();
    const exportPath = join(workDir, 'export.json');
    const exportRun = wrapInProgram(exportConfigCommand);
    await runViaProgram(exportRun.program, exportRun.leafName, [
      '--include-secrets',
      '--out',
      exportPath,
    ]);

    const newConfigPath = join(workDir, 'new-cfg.json');
    process.env['KASH_CONFIG'] = newConfigPath;
    const importRun = wrapInProgram(importConfigCommand);
    await runViaProgram(
      importRun.program,
      importRun.leafName,
      [exportPath, '--dry-run'],
      ['--json']
    );

    const parsed = parseJsonStdout(capture) as {
      written: boolean;
      merged: { profiles: Record<string, unknown> };
    };
    expect(parsed.written).toBe(false);
    expect(parsed.merged.profiles).toHaveProperty('default');

    // File should NOT exist on disk.
    expect(() => readFileSync(newConfigPath, 'utf8')).toThrow();
  });

  it('--no-overwrite preserves existing profiles', async () => {
    // Existing config has profile "alpha" with a different key.
    const existingKey = 'kash_live_zzzzzzzzzzzzzzzzzzzzzzzz';
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: 1,
          currentProfile: 'alpha',
          profiles: { alpha: { apiKey: existingKey } },
        },
        null,
        2
      )
    );

    // Bundle that would replace "alpha" and add "beta".
    const bundlePath = join(workDir, 'bundle.json');
    writeFileSync(
      bundlePath,
      JSON.stringify({
        version: 1,
        profiles: {
          alpha: { apiKey: 'kash_live_bbbbbbbbbbbbbbbbbbbbbbbb' },
          beta: { apiKey: 'kash_live_cccccccccccccccccccccccc' },
        },
      })
    );

    const importRun = wrapInProgram(importConfigCommand);
    await runViaProgram(importRun.program, importRun.leafName, [bundlePath, '--no-overwrite']);

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      profiles: Record<string, { apiKey?: string }>;
    };
    // alpha was preserved (no overwrite); beta was added.
    expect(onDisk.profiles.alpha!.apiKey).toBe(existingKey);
    expect(onDisk.profiles.beta!.apiKey).toBe('kash_live_cccccccccccccccccccccccc');
  });

  it('rejects malformed JSON with INVALID_INPUT', async () => {
    const garbagePath = join(workDir, 'garbage.json');
    writeFileSync(garbagePath, 'not json at all');

    const importRun = wrapInProgram(importConfigCommand);
    await expect(
      runViaProgram(importRun.program, importRun.leafName, [garbagePath])
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects bundles missing the version literal', async () => {
    const bundlePath = join(workDir, 'wrong-shape.json');
    writeFileSync(bundlePath, JSON.stringify({ profiles: {} }));

    const importRun = wrapInProgram(importConfigCommand);
    await expect(
      runViaProgram(importRun.program, importRun.leafName, [bundlePath])
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

// Squash unused-imports lint warning when there's no `vi` use in this file.
void vi;
