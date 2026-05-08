import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the public mirror repo. Matches the monorepo's
 * unit + component scope but excludes the `*.private.test.ts`
 * pattern (no such tests live in the mirror today, but the exclusion
 * is forward-compatible).
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/component/**/*.test.ts'],
    exclude: ['**/*.private.test.ts', '**/node_modules/**', '**/dist/**'],
    reporters: ['dot'],
  },
});
