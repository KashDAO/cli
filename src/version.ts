/**
 * Package version stamp.
 *
 * Hardcoded rather than imported from `package.json` because:
 *
 *   1. JSON imports vary across runtimes; the bundled CLI must work
 *      under Node 22+ regardless of how the consumer's tsconfig is
 *      shaped.
 *   2. tsup's JSON-bundling behaviour is bundler-version-specific and
 *      we'd rather not depend on it.
 *   3. A simple constant is auditable: `git grep CLI_VERSION` finds
 *      every reference instantly.
 *
 * **Maintenance**: bumped in lockstep with `package.json#version` by
 * the changesets release flow. The unit test in
 * `tests/unit/version.test.ts` reads `package.json` and asserts the
 * two stay in sync, so a forgotten bump fails CI before the bad
 * release ships to npm.
 */
export const CLI_VERSION = '0.1.1';
