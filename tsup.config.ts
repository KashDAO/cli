import { defineConfig } from 'tsup';

/**
 * Bundle config for `@kashdao/cli` (the `kash` binary).
 *
 * - ESM-only: the binary is invoked via shebang under Node 22+.
 * - Targets ES2022 to keep stack traces and async semantics clean
 *   (no transpiler downlevel).
 * - The shebang banner is emitted in the bundled output so the
 *   compiled file is directly executable.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  banner: {
    js: '#!/usr/bin/env node',
  },
});
