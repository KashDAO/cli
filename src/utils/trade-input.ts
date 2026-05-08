/**
 * Shared input parsers for every trade-execution command.
 *
 * Three modes share these primitives:
 *
 *   - SA mode (`kash protocol trade …`, `kash protocol userop build …`)
 *     — converts to atomic units (bigint) for the protocol-sdk.
 *   - EOA mode (`kash eoa trade …`) — same atomic-unit conversion.
 *   - Public-API mode (`kash trade buy/sell`) — ships the raw string
 *     to the hosted-API SDK, so it uses the shape validators
 *     (`validateUsdcDecimalShape`, `parseOutcomeIndex`) rather than
 *     the atomic-unit converters.
 *
 * Centralising the parsers eliminates three sources of drift:
 *
 *   1. **Validation messages** — the same flag should produce the
 *      same error wording regardless of mode.
 *   2. **Bounds** — slippage caps, outcome-index ceilings, USDC
 *      decimal precision must be identical across modes (otherwise
 *      operators get different errors for the same value).
 *   3. **Real-money correctness** — these inputs feed the SDK's
 *      atomic-unit math (or the API's server-side conversion); one
 *      drift between modes would silently change a trade's effective
 *      amount.
 */

import { CliValidationError } from '../errors.js';

/** Standard 0x-prefixed 40-char EVM address. */
export const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
/** 32-byte hash (UserOp hashes, tx hashes). */
export const HEX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;
/**
 * Stringified non-negative bigint (canonical decimal). Used by Zod
 * envelopes that must round-trip a `bigint` field through JSON without
 * losing precision — the wire shape is "every digit, no scientific
 * notation, no leading sign". Single source of truth so the SA-mode
 * direct-client envelopes (`OnChainBalanceSchema`, `MarketStateSchema`,
 * `QuoteSchema`) can't drift on what counts as a valid encoding.
 */
export const BIGINT_STRING_REGEX = /^\d+$/;
/**
 * Human USDC decimal: whole digits with up to 6 fractional digits.
 * Backs both the `validateUsdcDecimalShape` runtime check and the
 * `kash trade buy/sell --dry-run --json` envelope schema, so the
 * runtime parser and the JSON contract can't disagree on what
 * counts as a valid amount.
 */
export const USDC_DECIMAL_REGEX = /^\d+(\.\d{1,6})?$/;

/** Default slippage tolerance in basis points (50 = 0.5%). */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** ERC-20's `MAX_UINT256` — sentinel for "infinite" approval. */
export const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Validate a market / spender / account address. Throws
 * `INVALID_INPUT` with the supplied field name (so the structured
 * error envelope's `check_input` action points at the right flag).
 */
export function validateAddress(value: string, field: string): `0x${string}` {
  if (!HEX_ADDRESS_REGEX.test(value)) {
    throw new CliValidationError(
      `<${field}> must be a 0x-prefixed 40-char hex address.`,
      `Got "${value}".`,
      field
    );
  }
  return value as `0x${string}`;
}

/**
 * Optional variant of {@link validateAddress}. Returns `undefined`
 * when the input is `undefined` (the common "default to active
 * profile's account" pattern); otherwise validates and returns the
 * narrowed type.
 */
export function validateAddressOptional(
  value: string | undefined,
  field: string
): `0x${string}` | undefined {
  return value === undefined ? undefined : validateAddress(value, field);
}

/**
 * Strict-shape regex for unsigned integer flag values. Bare digits
 * only (with optional leading `+`). Anything else — `1.5`, `1e3`,
 * `0x10`, ` 42`, `42 `, `1 2` — must be rejected.
 *
 * Plain `Number.parseInt('1.5', 10)` returns `1` and
 * `Number.parseInt('1e3', 10)` returns `1` too. Both are silent
 * precision losses on inputs that look like real-money typos:
 *   - `--outcome 1.5` would buy outcome 1 (wrong outcome).
 *   - `--slippage-bps 1e3` would use 1 bps instead of 1000 (10%
 *     slippage clipped to 0.01% — catastrophic).
 *
 * Every flag-parser in this module that consumes integers MUST
 * gate its `Number.parseInt` call on this regex.
 */
const UNSIGNED_INT_REGEX = /^\+?\d+$/;

/**
 * Outcome index in `[0, 7]` (Pythagorean AMM ceiling — markets carry
 * 2-8 outcomes). Throws `INVALID_INPUT` on missing or out-of-range.
 */
export function parseOutcomeIndex(raw: string | undefined): number {
  if (raw === undefined) {
    throw new CliValidationError('--outcome is required.', undefined, 'outcome');
  }
  if (!UNSIGNED_INT_REGEX.test(raw)) {
    throw new CliValidationError(
      '--outcome must be an integer between 0 and 7.',
      `Got "${raw}". Pass digits only — no decimals (\`1.5\` would silently round to 1) or scientific notation.`,
      'outcome'
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 7) {
    throw new CliValidationError(
      '--outcome must be an integer between 0 and 7.',
      'Markets carry 2-8 outcomes; the index is 0-based.',
      'outcome'
    );
  }
  return n;
}

/**
 * `--side` parser shared by `kash protocol quote` and `kash eoa trade`.
 * Returns the canonical uppercase form (`'BUY' | 'SELL'`) the SDKs
 * expect. Case-insensitive on input.
 *
 * The lowercase variant (`'buy' | 'sell'`) used by the public-API
 * predictions feed (`kash markets predictions --side buy`) lives at
 * its sole call site — it has different semantics (filter rather
 * than execute) and routes through a separate API endpoint.
 */
export function parseUppercaseSide(raw: string, name = 'side'): 'BUY' | 'SELL' {
  const upper = raw.toUpperCase();
  if (upper !== 'BUY' && upper !== 'SELL') {
    throw new CliValidationError(
      `--${name} must be one of: BUY, SELL (case-insensitive).`,
      `Got "${raw}".`,
      name
    );
  }
  return upper;
}

/**
 * One-shot trade-execution side. SA mode (`kash protocol trade …`)
 * and EOA mode (`kash eoa trade …`) share this enum — `close` is the
 * "sell my entire balance for outcome N" sugar.
 */
export type TradeOpSide = 'buy' | 'sell' | 'close';

/**
 * Slippage in basis points (0..10000 → 0%..100%).
 *
 * Strict integer shape: `parseInt('1e3', 10)` returns 1, which would
 * silently clip 10% slippage to 0.01% (catastrophic for any real
 * trade). The shape check rejects any non-bare-integer before the
 * range check runs.
 */
export function parseSlippageBps(raw: string): number {
  if (!UNSIGNED_INT_REGEX.test(raw)) {
    throw new CliValidationError(
      '--slippage-bps must be an integer between 0 and 10000.',
      `Got "${raw}". Pass digits only — \`1e3\` would silently parse as 1 (0.01%) instead of 1000 (10%).`,
      'slippage-bps'
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) {
    throw new CliValidationError(
      '--slippage-bps must be an integer between 0 and 10000.',
      `Got "${raw}". 50 = 0.5%, 100 = 1%, 10000 = 100%.`,
      'slippage-bps'
    );
  }
  return n;
}

/**
 * Unix-seconds deadline as a bigint. Caps the value at
 * `Number.MAX_SAFE_INTEGER` to catch the common ms-vs-sec confusion
 * (a JS `Date.now()` value passed verbatim would overflow into the
 * year 50000+ AD, which the AMM treats as "no deadline" and is
 * indistinguishable from the user's intent).
 */
export function parseDeadlineSec(raw: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(raw);
  } catch {
    throw new CliValidationError(
      '--deadline-sec must be a unix timestamp in seconds.',
      `Got "${raw}".`,
      'deadline-sec'
    );
  }
  if (parsed <= 0n) {
    throw new CliValidationError(
      '--deadline-sec must be positive.',
      `Got "${raw}".`,
      'deadline-sec'
    );
  }
  // Sanity check: the largest value that fits in a JS safe integer is
  // ~9e15. Anything above that is almost certainly the user passing
  // milliseconds instead of seconds, and `Number(parsed)` would lose
  // precision in downstream code.
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CliValidationError(
      '--deadline-sec is impossibly far in the future.',
      `Got ${String(parsed)}. Did you pass milliseconds by mistake? Convert to seconds first.`,
      'deadline-sec'
    );
  }
  return parsed;
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
 * Generic partial-completion hash extractor. SA-mode and EOA-mode
 * trade runners catch SDK errors that may carry an already-landed
 * hash (`userOpHash` for SA, `transactionHash` for EOA) in the
 * cause's `context` field — we surface that hash so the operator
 * can resume rather than pay for a duplicate sign/submit cycle.
 *
 * **Discrimination matters here.** Multiple SDK error classes
 * populate `context.<hash>` with the same shape, so we narrow on
 * the SDK's own `code` enum first:
 *
 *   - SA mode: `code === 'BUNDLER_RECEIPT_TIMEOUT'` (genuine partial
 *     completion — submit succeeded, wait timed out). Other SA
 *     errors like `KashSignerError` (`SIGNER_SIGN_FAILED`) ALSO
 *     carry `context.userOpHash` but happen pre-submit, so reporting
 *     them as partial completions would be actively misleading.
 *   - EOA mode: `code === 'WAIT_RECEIPT_FAILED'` (post-submit wait
 *     timeout). Other `KashChainError` variants like
 *     `CHAIN_RPC_FAILED` carry no transactionHash and would fail
 *     the `contextKey` lookup anyway, but the code-narrow catches
 *     them earlier.
 *
 * The `cause` argument is `unknown` because it crosses the SDK ↔
 * CLI boundary; reads are defensive at every step.
 */
export function extractPartialHash(
  cause: unknown,
  options: { code: string; contextKey: 'userOpHash' | 'transactionHash' }
): `0x${string}` | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  const code = (cause as { code?: unknown }).code;
  if (code !== options.code) return undefined;
  const ctx = (cause as { context?: unknown }).context;
  if (ctx === null || typeof ctx !== 'object') return undefined;
  const hash = (ctx as Record<string, unknown>)[options.contextKey];
  return typeof hash === 'string' && HEX_HASH_REGEX.test(hash)
    ? (hash as `0x${string}`)
    : undefined;
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
