/**
 * package.json `bin` ↔ README/QUICKSTART command-name drift detector.
 *
 * The CLI publishes a binary named `kash` via package.json's `bin`
 * field. README.md and QUICKSTART.md both contain command examples
 * like `kash auth set-key …` and `kash markets list`. If anyone ever
 * renames the bin entry (rebrand, npm-publish-conflict, etc.) the
 * docs silently stale and `npm i -g @kashdao/cli && kash --help`
 * produces `command not found: kash` — at the worst possible moment
 * for a customer.
 *
 * Round AG closed the equivalent gap for the public-API QUICKSTART
 * (curl URLs ↔ OpenAPI routes). This round closes it for the CLI's
 * customer-facing entry point.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PACKAGE_JSON = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
) as {
  readonly name?: string;
  readonly bin?: Record<string, string>;
};

const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
const QUICKSTART_PATH = fileURLToPath(new URL('../../QUICKSTART.md', import.meta.url));
// QUICKSTART is optional — only read if present.
let QUICKSTART: string | null = null;
try {
  QUICKSTART = readFileSync(QUICKSTART_PATH, 'utf8');
} catch {
  QUICKSTART = null;
}

describe('packages/cli — bin name drift', () => {
  it('package.json declares a non-empty `bin` field', () => {
    // Without `bin`, `npm i -g @kashdao/cli` installs nothing
    // executable — silent failure for every customer who copied the
    // README's install instructions.
    expect(PACKAGE_JSON.bin).toBeDefined();
    expect(Object.keys(PACKAGE_JSON.bin ?? {}).length).toBeGreaterThan(0);
  });

  it('canonical binary name `kash` is in the bin map', () => {
    // The README and QUICKSTART command examples ALL begin with
    // `kash …`. A rename to anything else (`kashcli`, `kashdao`)
    // would break every documented invocation.
    expect(
      PACKAGE_JSON.bin?.['kash'],
      `package.json bin map is missing the canonical "kash" entry. ` +
        `Current bin map: ${JSON.stringify(PACKAGE_JSON.bin)}. ` +
        `If the rename is intentional, update README.md and QUICKSTART.md to use the new name, then update this test.`
    ).toBeDefined();
  });

  it('bin entries point at files inside dist/ (built JS)', () => {
    // The bin path must resolve to a built file, not a TS source
    // file — `npm i -g` doesn't run the TS compiler. A regression
    // here means `kash --version` fails on a fresh install with
    // `cannot find module ../src/index.ts`.
    for (const [name, target] of Object.entries(PACKAGE_JSON.bin ?? {})) {
      expect(target, `bin entry "${name}" points at ${target}`).toMatch(/^\.\/dist\//);
    }
  });

  it('README command examples use the documented bin name', () => {
    // README has lines like `kash auth set-key kash_live_…`. Each
    // such example's leading word must be a bin-map key — otherwise
    // the documentation is teaching customers a command they don't
    // have.
    //
    // The check is intentionally loose: we only care that command
    // lines starting with `kash ` exist and that `kash` is in the
    // bin map (verified above). Replacing this with a fuzzy "every
    // shell example starts with a known bin" check would be brittle
    // (the README also has `npm i -g @kashdao/cli` lines which
    // shouldn't trigger).
    expect(
      /\bkash\s+(auth|markets|trade|webhooks|version|config|--version|--help)/.test(README),
      'README has no "kash <subcommand>" command examples. ' +
        'Either the README is empty / refactored, or the bin name was renamed. ' +
        'Update this test or the README.'
    ).toBe(true);
  });

  it('QUICKSTART (if present) uses the documented bin name', () => {
    if (QUICKSTART === null) {
      // CLI may not ship a QUICKSTART today — the test passes by
      // virtue of nothing to check. The presence check above pins
      // the README, which is the load-bearing surface.
      return;
    }
    expect(
      /\bkash\s+\w/.test(QUICKSTART),
      'QUICKSTART.md is missing "kash <subcommand>" examples.'
    ).toBe(true);
  });
});
