/**
 * Shared input parsers for the trade, quote, redeem and predictions
 * commands.
 *
 * `kash trade buy/sell` ships the raw USDC decimal to the SDK, so it uses
 * the shape validators (`validateUsdcDecimalShape`, `parseOutcomeIndex`);
 * `kash quote buy/sell` sends atomic units, so it uses the converters
 * (`decimalToAtomicUsdc`, `decimalToAtomicWad`).
 *
 * Centralising the parsers eliminates three sources of drift:
 *
 *   1. **Validation messages** — the same flag should produce the
 *      same error wording on every command.
 *   2. **Bounds** — outcome-index ceilings and USDC decimal precision
 *      must be identical across commands (otherwise operators get
 *      different errors for the same value).
 *   3. **Real-money correctness** — these inputs feed the API's amount
 *      handling; one drift between commands would silently change a
 *      trade's effective amount.
 */

import { CliValidationError } from '../errors.js';

/**
 * Human USDC decimal: whole digits with up to 6 fractional digits.
 * Backs both the `validateUsdcDecimalShape` runtime check and the
 * `kash trade buy/sell --dry-run --json` envelope schema, so the
 * runtime parser and the JSON contract can't disagree on what
 * counts as a valid amount.
 */
export const USDC_DECIMAL_REGEX = /^\d+(\.\d{1,6})?$/;

/**
 * Strict-shape regex for unsigned integer flag values. Bare digits
 * only (with optional leading `+`). Anything else — `1.5`, `1e3`,
 * `0x10`, ` 42`, `42 `, `1 2` — must be rejected.
 *
 * Plain `Number.parseInt('1.5', 10)` returns `1` and
 * `Number.parseInt('1e3', 10)` returns `1` too. Both are silent
 * precision losses on inputs that look like real-money typos:
 *   - `--outcome 1.5` would buy outcome 1 (wrong outcome).
 *   - `--outcome 1e1` would buy outcome 1 instead of 10.
 *
 * Every flag-parser in this module that consumes integers MUST
 * gate its `Number.parseInt` call on this regex.
 */
const UNSIGNED_INT_REGEX = /^\+?\d+$/;

/**
 * Highest valid 0-based outcome index. Markets carry 2-100 outcomes (the
 * AMM's `MAX_OUTCOMES`); 96-outcome markets exist.
 */
const MAX_OUTCOME_INDEX = 99;

/**
 * Outcome index in `[0, 99]`. Throws `INVALID_INPUT` on missing or
 * out-of-range.
 */
export function parseOutcomeIndex(raw: string | undefined): number {
  if (raw === undefined) {
    throw new CliValidationError('--outcome is required.', undefined, 'outcome');
  }
  if (!UNSIGNED_INT_REGEX.test(raw)) {
    throw new CliValidationError(
      `--outcome must be an integer between 0 and ${MAX_OUTCOME_INDEX}.`,
      `Got "${raw}". Pass digits only — no decimals (\`1.5\` would silently round to 1) or scientific notation.`,
      'outcome'
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_OUTCOME_INDEX) {
    throw new CliValidationError(
      `--outcome must be an integer between 0 and ${MAX_OUTCOME_INDEX}.`,
      'Markets carry 2-100 outcomes; the index is 0-based.',
      'outcome'
    );
  }
  return n;
}

/**
 * Validate that a string is a well-formed USDC decimal (whole or up
 * to 6 fractional digits). Used by call sites that need the
 * shape check but pass the raw string downstream rather than
 * converting to atomic units (e.g. `kash trade buy/sell` ships the
 * decimal verbatim to the public-API SDK, which handles atomic
 * conversion server-side).
 */
export function validateUsdcDecimalShape(decimal: string, name: string): void {
  if (!USDC_DECIMAL_REGEX.test(decimal)) {
    throw new CliValidationError(
      `--${name} must be a USDC decimal with up to 6 fractional digits.`,
      `Got "${decimal}". USDC accepts up to 6 fractional digits (e.g. "10", "12.50", "0.000001").`,
      name
    );
  }
}

/**
 * Convert a USDC decimal string (`"10"`, `"12.50"`, `"0.000001"`)
 * to the 6-decimal atomic representation the AMM expects.
 *
 * Rejects strings with more than 6 fractional digits — silently
 * truncating could lose precision the user expected to preserve.
 */
export function decimalToAtomicUsdc(decimal: string, name: string): bigint {
  validateUsdcDecimalShape(decimal, name);
  const [whole, frac = ''] = decimal.split('.');
  const fracPadded = frac.padEnd(6, '0');
  return BigInt(`${whole}${fracPadded}`);
}

/**
 * Convert a token decimal string (`"1.5"`, `"0.0001"`) to WAD-18
 * atomic units. Outcome tokens use 18-decimal precision throughout
 * the protocol.
 */
export function decimalToAtomicWad(decimal: string, name: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(decimal)) {
    throw new CliValidationError(
      `--${name} must be a token decimal with up to 18 fractional digits.`,
      `Got "${decimal}". Outcome tokens use WAD-18 precision.`,
      name
    );
  }
  const [whole, frac = ''] = decimal.split('.');
  const fracPadded = frac.padEnd(18, '0');
  return BigInt(`${whole}${fracPadded}`);
}
