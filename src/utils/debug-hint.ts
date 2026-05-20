/**
 * Helpers for the "Re-run with --debug for verbose HTTP logs" hint
 * emitted on the error path in `src/index.ts`.
 *
 * Factored out of `src/index.ts` so the helpers are unit-testable —
 * `index.ts` is the CLI entry point and runs Commander at module load,
 * so importing it from a test triggers `process.exit`.
 */

/**
 * Recognise truthy env values the way every other tool does: `1`,
 * `true`, `yes`, `on` (case-insensitive). Empty string and `0` are
 * falsy. Anything else is a no-op rather than an error — env
 * pollution is common and shouldn't fail builds.
 *
 * Local copy of the same helper that lives in `utils/global-options.ts`
 * — kept in sync intentionally; the two MUST agree on what counts as
 * "debug on" or the UX gets confusing (readGlobals decides "is
 * --debug active?" via isTruthyEnv, and the error path's hint decides
 * "should I suggest --debug?" via the same rule).
 */
function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * "Is debug already on?" — used on the error path to decide whether to
 * promote `--debug` as a next-step hint. Mirrors readGlobals'
 * resolution: either the `--debug` flag is in argv, or `KASH_DEBUG`
 * is a *truthy* value per the shared `isTruthyEnv` rule.
 *
 * Critical: a bare presence check on `KASH_DEBUG` would mistakenly
 * skip the hint when the user has `KASH_DEBUG=0` / `=false` / `=no`
 * set — those env values do NOT enable debug mode in readGlobals,
 * so the hint should still fire. The two resolution paths must
 * agree or the UX gets confused.
 *
 * Pure inputs → pure output; safe to invoke with synthetic argv/env
 * in unit tests without touching `process`.
 */
export function isDebugOn(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return argv.slice(2).includes('--debug') || isTruthyEnv(env['KASH_DEBUG']);
}

/**
 * Promote `--debug` for codes where verbose HTTP logs help — anything
 * the operator can't fix by changing input. Validation / config /
 * input errors don't benefit from more logs (the cause is right there
 * in the message).
 */
export function shouldPromoteDebug(code: string): boolean {
  switch (code) {
    case 'INVALID_INPUT':
    case 'CONFIGURATION':
    case 'INVALID_USEROP':
    case 'INSUFFICIENT_FUNDS':
    case 'INSUFFICIENT_GAS':
    case 'INSUFFICIENT_SCOPE':
      return false;
    default:
      return true;
  }
}
