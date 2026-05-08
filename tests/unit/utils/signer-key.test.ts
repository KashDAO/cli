/**
 * Unit tests for `utils/signer-key.ts`.
 *
 * Both direct-mode (SA UserOps) and EOA-mode (vanilla EIP-1559 txs)
 * resolve their private key through this single helper. A drift
 * between the two paths on file/env reading, hex validation, or
 * error wording would be a real-money risk: the SA flow signs a
 * UserOpHash, the EOA flow signs a transaction; both hold the same
 * key, so any divergence in resolution semantics could mean one path
 * succeeds while the other silently fails (or worse, succeeds with a
 * mis-trimmed key).
 *
 * Tests cover every branch of the parser:
 *   - undefined / missing scheme
 *   - file: branch (success, missing path, unreadable)
 *   - env: branch (success, missing name, unset variable)
 *   - hex validation (length, prefix, character set, whitespace)
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../../../src/errors.js';
import { loadRawPrivateKey } from '../../../src/utils/signer-key.js';

/**
 * Write a key file at the canonical 0600 mode so the chmod warning
 * branch in `loadRawPrivateKey` doesn't fire for tests that aren't
 * exercising it. (mkdtemp/writeFile default to ~0644.)
 */
async function writeSecureKeyFile(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

const VALID_KEY = `0x${'a'.repeat(64)}` as const;
const ENV_VAR = 'SIGNER_KEY_TEST_VAR';

describe('loadRawPrivateKey — required-input branch', () => {
  it('throws SIGNER_FAILED when ref is undefined', async () => {
    await expect(loadRawPrivateKey(undefined)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws SIGNER_FAILED when ref is empty string', async () => {
    await expect(loadRawPrivateKey('')).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws CliError on unknown scheme', async () => {
    await expect(loadRawPrivateKey('s3://bucket/key')).rejects.toBeInstanceOf(CliError);
    await expect(loadRawPrivateKey('s3://bucket/key')).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('rejects a bare hex value without a scheme prefix (would be silently mis-classified)', async () => {
    // `0x` + 64 chars has no `:` separator, so the scheme is the whole
    // string and `target` is empty — the unknown-scheme branch should
    // catch this rather than letting the value through.
    await expect(loadRawPrivateKey(VALID_KEY)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });
});

describe('loadRawPrivateKey — file: branch', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kash-signer-test-'));
    keyPath = join(dir, 'key.hex');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a 0x-prefixed hex key from disk', async () => {
    await writeSecureKeyFile(keyPath, VALID_KEY);
    const out = await loadRawPrivateKey(`file:${keyPath}`);
    expect(out).toBe(VALID_KEY);
  });

  it('trims surrounding whitespace / trailing newline', async () => {
    await writeSecureKeyFile(keyPath, `${VALID_KEY}\n`);
    expect(await loadRawPrivateKey(`file:${keyPath}`)).toBe(VALID_KEY);
  });

  it('trims leading whitespace too', async () => {
    await writeSecureKeyFile(keyPath, `\n  ${VALID_KEY}\n`);
    expect(await loadRawPrivateKey(`file:${keyPath}`)).toBe(VALID_KEY);
  });

  it('throws when the path is empty (`file:`)', async () => {
    await expect(loadRawPrivateKey('file:')).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the file does not exist', async () => {
    await expect(loadRawPrivateKey(`file:${join(dir, 'missing')}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the file contents are not valid hex', async () => {
    await writeSecureKeyFile(keyPath, 'not-a-key');
    await expect(loadRawPrivateKey(`file:${keyPath}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the file holds a 31-byte (too-short) key', async () => {
    await writeSecureKeyFile(keyPath, `0x${'a'.repeat(62)}`);
    await expect(loadRawPrivateKey(`file:${keyPath}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the file holds a 33-byte (too-long) key', async () => {
    await writeSecureKeyFile(keyPath, `0x${'a'.repeat(66)}`);
    await expect(loadRawPrivateKey(`file:${keyPath}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('handles paths containing colons (full target after the first scheme separator)', async () => {
    // `file:/some:weird/path` should pass `/some:weird/path` to readFile.
    // We can't actually exercise this on disk reliably, but we can
    // assert that a path with a colon doesn't get truncated at the
    // colon: the error should be ENOENT-like, not "empty path".
    await expect(loadRawPrivateKey('file:/no/such:colon/path')).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
      message: expect.stringContaining('/no/such:colon/path'),
    });
  });
});

describe('loadRawPrivateKey — file mode warning (POSIX only)', () => {
  let dir: string;
  let keyPath: string;
  let stderrBuf: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kash-signer-mode-'));
    keyPath = join(dir, 'key.hex');
    stderrBuf = '';
    originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
      stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    };
  });

  afterEach(async () => {
    process.stderr.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')('emits a warning when the key file is 0644', async () => {
    await writeFile(keyPath, VALID_KEY);
    await chmod(keyPath, 0o644);
    await loadRawPrivateKey(`file:${keyPath}`);
    expect(stderrBuf).toContain('signerKeyRef file mode');
    expect(stderrBuf).toContain('chmod 600');
  });

  it.runIf(process.platform !== 'win32')(
    'emits a warning when the key file is group-readable (0640)',
    async () => {
      await writeFile(keyPath, VALID_KEY);
      await chmod(keyPath, 0o640);
      await loadRawPrivateKey(`file:${keyPath}`);
      expect(stderrBuf).toContain('signerKeyRef file mode');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'does NOT warn when the key file is 0600 (canonical owner-only)',
    async () => {
      await writeSecureKeyFile(keyPath, VALID_KEY);
      await loadRawPrivateKey(`file:${keyPath}`);
      expect(stderrBuf).toBe('');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'does NOT warn when the key file is 0400 (read-only owner)',
    async () => {
      await writeFile(keyPath, VALID_KEY);
      await chmod(keyPath, 0o400);
      await loadRawPrivateKey(`file:${keyPath}`);
      expect(stderrBuf).toBe('');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'still loads the key successfully despite the warning (warning is advisory only)',
    async () => {
      await writeFile(keyPath, VALID_KEY);
      await chmod(keyPath, 0o644);
      const out = await loadRawPrivateKey(`file:${keyPath}`);
      expect(out).toBe(VALID_KEY);
    }
  );
});

describe('loadRawPrivateKey — env: branch', () => {
  beforeEach(() => {
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('reads a 0x-prefixed hex key from a process env var', async () => {
    process.env[ENV_VAR] = VALID_KEY;
    expect(await loadRawPrivateKey(`env:${ENV_VAR}`)).toBe(VALID_KEY);
  });

  it('trims surrounding whitespace from env values', async () => {
    process.env[ENV_VAR] = ` ${VALID_KEY}\n`;
    expect(await loadRawPrivateKey(`env:${ENV_VAR}`)).toBe(VALID_KEY);
  });

  it('throws when the env var name is empty (`env:`)', async () => {
    await expect(loadRawPrivateKey('env:')).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the env var is not set', async () => {
    await expect(loadRawPrivateKey(`env:${ENV_VAR}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the env var is set to empty string', async () => {
    process.env[ENV_VAR] = '';
    await expect(loadRawPrivateKey(`env:${ENV_VAR}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the env var holds malformed hex', async () => {
    process.env[ENV_VAR] = '0xZZZZ';
    await expect(loadRawPrivateKey(`env:${ENV_VAR}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });

  it('throws when the env var holds a key without 0x prefix', async () => {
    process.env[ENV_VAR] = 'a'.repeat(64);
    await expect(loadRawPrivateKey(`env:${ENV_VAR}`)).rejects.toMatchObject({
      code: 'SIGNER_FAILED',
    });
  });
});
