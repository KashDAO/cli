import baseConfig from '@kashdao/eslint-config/base.js';

export default [
  {
    ignores: ['vitest.config.ts', 'tsup.config.ts', 'dist/**', 'node_modules/**'],
  },
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      // The CLI prints to stdout/stderr by design — these are user-facing channels,
      // not log streams. Output goes through src/utils/output.ts which centralises
      // chalk and quiet handling, so disabling no-console here keeps that file
      // honest while still flagging stray console.* in command code.
      'no-console': 'off',
      // Top-level await is fine in the CLI entry point.
      'unicorn/prefer-top-level-await': 'off',
    },
  },
];
