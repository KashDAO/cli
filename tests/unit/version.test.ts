/**
 * Drift check: CLI_VERSION must match `package.json#version`.
 *
 * If a release bumps the package version and forgets to update
 * `src/version.ts`, this test fails before the artifact reaches npm
 * — preventing a published binary that lies about its own version.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLI_VERSION } from '../../src/version.js';

describe('CLI version stamp', () => {
  it('matches package.json#version', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
