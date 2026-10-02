/**
 * Regenerate `src/api-error-bundle.generated.ts` before any test runs.
 *
 * The bundle is derived from `docs/api-errors/<CODE>.md` and is gitignored, so
 * whatever is on disk is whatever the last build left there. `package.json`'s
 * `test:unit` regenerates it first — but the ROOT runner does not use that
 * script. `npx vitest run --project '@kashdao/cli'` invokes vitest directly,
 * skips the generation, and tests a STALE file.
 *
 * MEASURED 2026-08-29: that is exactly what happened. A `docs/api-errors` page
 * added six days earlier was missing from a bundle dated before it, and the
 * root batch reported `1 failed | 4115 passed` for a tree in which nothing was
 * wrong. Running the package's own script passed; the root batch failed. The
 * defect was in how the suite was invoked, and the suite could not say so.
 *
 * Of 197 packages declaring `test:unit`, this is the ONLY one whose script does
 * work before vitest. Moving that work into `globalSetup` means the project
 * carries its own precondition, so every runner — the package script, the root
 * batch, an IDE, a future CI shape — gets the same answer.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default function setup(): void {
  execFileSync('npx', ['tsx', 'scripts/build-api-error-bundle.ts'], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
  });
}
