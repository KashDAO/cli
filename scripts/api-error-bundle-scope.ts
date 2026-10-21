/**
 * Which `docs/api-errors/<CODE>.md` pages ship in the CLI's offline bundle.
 *
 * Codes that belong to endpoints that are not generally available are left
 * out, so `kash explain` documents only what a public API consumer can reach.
 * Shared by the bundle builder and its test so the two cannot disagree.
 */
export const EXCLUDED_CODE_PREFIXES: readonly string[] = ['COMPETITION_'];

export function isBundledErrorCode(code: string): boolean {
  return !EXCLUDED_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}
