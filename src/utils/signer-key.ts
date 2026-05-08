/**
 * Shared `signerKeyRef` resolution for direct-mode + EOA-mode clients.
 *
 * Both modes pull the EOA's private key from the same place:
 *
 *   - `file:<absolute-path>` — read a 0x-prefixed hex key from disk.
 *                              On POSIX, the file mode is checked and
 *                              a warning is emitted (but the load is
 *                              not refused) if the file is readable
 *                              by group or other — the same discipline
 *                              as ssh / aws-cli warning on
 *                              `~/.ssh/id_rsa` permissions, but
 *                              non-fatal because a CI runner may
 *                              legitimately stage keys with broader
 *                              modes inside an ephemeral container.
 *   - `env:<NAME>`            — read a 0x-prefixed hex key from a
 *                                process env var. (No mode check
 *                                applies — the OS does not expose
 *                                env-var ACLs.)
 *
 * The CLI never persists raw keys (the config schema only stores the
 * reference, not the key itself). This helper validates the format
 * and resolves the raw bytes; the caller wraps them in the right
 * adapter for its mode (`viemAccountSigner` for SA UserOps,
 * `viemAccountEoaSigner` for vanilla EIP-1559 txs).
 *
 * Centralised so the SA and EOA paths can never drift on the
 * file/env reading, hex validation, or error wording — drift here is
 * a real-money risk.
 */

import { readFile, stat } from 'node:fs/promises';

import { CliError } from '../errors.js';

import { log } from './output.js';

/** 0x-prefixed 32-byte hex private key. */
export type RawPrivateKey = `0x${string}`;

/** Loosely-typed regex for a private key — not a cryptographic check. */
const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolve a `signerKeyRef` to its raw 0x-prefixed hex private key.
 * Throws `CliError(SIGNER_FAILED)` for every failure mode (missing
 * scheme, missing file/env, malformed key) so callers get a uniform
 * structured envelope.
 */
export async function loadRawPrivateKey(ref: string | undefined): Promise<RawPrivateKey> {
  if (!ref) {
    throw new CliError('signerKeyRef is required.', {
      code: 'SIGNER_FAILED',
      suggestion:
        '`kash config set signerKeyRef file:<path>` or `env:<NAME>` (CLI never persists raw keys).',
    });
  }

  const [scheme, ...rest] = ref.split(':');
  const target = rest.join(':');

  let rawKey: string;
  if (scheme === 'file') {
    if (target === '') {
      throw new CliError('signerKeyRef: file path is empty.', {
        code: 'SIGNER_FAILED',
        suggestion: 'Use `signerKeyRef = file:<absolute-path>` with a path to the private key.',
      });
    }
    try {
      rawKey = (await readFile(target, 'utf8')).trim();
    } catch (cause) {
      throw new CliError(`signerKeyRef: failed to read ${target}.`, {
        code: 'SIGNER_FAILED',
        suggestion: 'Verify the file exists, is readable, and contains a 0x-prefixed hex key.',
        cause,
      });
    }
    await warnIfWorldReadable(target);
  } else if (scheme === 'env') {
    if (target === '') {
      throw new CliError('signerKeyRef: env variable name is empty.', {
        code: 'SIGNER_FAILED',
        suggestion: 'Use `signerKeyRef = env:<NAME>` referencing an environment variable.',
      });
    }
    const fromEnv = process.env[target];
    if (!fromEnv) {
      throw new CliError(`signerKeyRef: environment variable ${target} is not set or empty.`, {
        code: 'SIGNER_FAILED',
        suggestion: `Set ${target} to a 0x-prefixed hex private key, or rotate to a file:<path> reference.`,
      });
    }
    rawKey = fromEnv.trim();
  } else {
    throw new CliError(`signerKeyRef: unknown scheme "${scheme ?? ''}".`, {
      code: 'SIGNER_FAILED',
      suggestion: 'Supported schemes: `file:<path>`, `env:<NAME>`.',
    });
  }

  if (!PRIVATE_KEY_REGEX.test(rawKey)) {
    throw new CliError('signerKeyRef target is not a 0x-prefixed 32-byte hex private key.', {
      code: 'SIGNER_FAILED',
      suggestion: 'The key must be exactly 0x followed by 64 hex characters (32 bytes).',
    });
  }

  return rawKey as RawPrivateKey;
}

/**
 * POSIX-only: warn (don't refuse) if the key file is readable by
 * group or other. Mirrors ssh / aws-cli's "you should `chmod 600`"
 * banner on `~/.ssh/id_rsa`. Skipped on Windows (no-op) because
 * Windows uses ACLs rather than POSIX modes — `mode & 0o077` is
 * meaningless. Skipped on stat failure because we just successfully
 * read the file; the stat is purely advisory.
 */
async function warnIfWorldReadable(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let mode: number;
  try {
    const info = await stat(path);
    mode = info.mode;
  } catch {
    return; // advisory only — we already loaded the key successfully
  }
  // Lower 9 bits are rwxrwxrwx. Group + other read bits are 0o044.
  // Lower 6 bits (group + other rwx) are 0o077 — anything set in
  // those positions means somebody other than the owner can touch
  // the key.
  if ((mode & 0o077) !== 0) {
    log.warn(
      `signerKeyRef file mode is 0${(mode & 0o777).toString(8)} (group/other readable). ` +
        `Run \`chmod 600 ${path}\` to restrict access. (warning only — load succeeded.)`
    );
  }
}
