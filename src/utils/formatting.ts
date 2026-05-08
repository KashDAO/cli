/**
 * Display formatters: tables, addresses, USDC amounts, status colors.
 *
 * Atomic USDC values from the API are integer strings (6 decimals). The
 * SDK does not assume a math library, so we format with simple integer
 * division here — the precision constraint is purely cosmetic.
 */

import Table from 'cli-table3';

import { style } from './output.js';

/**
 * ASCII ellipsis used for all truncation glyphs. We use three dots
 * rather than the Unicode horizontal-ellipsis (U+2026) because the
 * latter renders as `?` on Windows cmd.exe and in restricted locales
 * — `gh`, `aws`, and `stripe` all standardise on ASCII.
 */
const ELLIPSIS = '...';

/**
 * Code-point-safe slice. `String.prototype.slice` operates on UTF-16
 * code units, so an emoji or other surrogate pair near a boundary
 * could split. None of the inputs we slice (API keys, hex addresses,
 * UUIDs) carry surrogates today — but defensive slicing matches
 * `gh`/`aws` and the cost is negligible.
 */
function codepointSlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join('');
}

function codepointLength(s: string): number {
  return Array.from(s).length;
}

/** Truncate a UUID/long ID to "abcdef12..." for tables. */
export function shortId(id: string, prefix = 8): string {
  if (codepointLength(id) <= prefix + ELLIPSIS.length) return id;
  return `${codepointSlice(id, 0, prefix)}${ELLIPSIS}`;
}

/**
 * Truncate a free-form string to fit within a column. Appends an
 * ellipsis when shortened so the user sees that data was elided.
 * Different from `shortId`, which uses a leading-prefix heuristic
 * suited to UUIDs and tx hashes.
 */
export function truncate(s: string, max: number): string {
  return codepointLength(s) > max ? `${codepointSlice(s, 0, max - ELLIPSIS.length)}${ELLIPSIS}` : s;
}

/**
 * Redact an API key for display. Always shows enough leading
 * characters (`kash_live_` / `kash_test_` prefix) to confirm the key
 * type, plus the last four characters so users can match it to a
 * value they have on record. Inputs shorter than 8 characters are
 * masked entirely so we never accidentally leak a partial key from
 * truncated input.
 */
export function redact(key: string): string {
  if (codepointLength(key) <= 8) return '***';
  return `${codepointSlice(key, 0, 8)}${ELLIPSIS}${codepointSlice(key, -4)}`;
}

/** Capitalise the first letter. Empty strings pass through. */
export function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format an EVM address as `0x1234...abcd`. */
export function formatAddress(address: string, lead = 6, tail = 4): string {
  if (codepointLength(address) <= lead + tail + ELLIPSIS.length) return address;
  return `${codepointSlice(address, 0, lead)}${ELLIPSIS}${codepointSlice(address, -tail)}`;
}

/** Format a UTC ISO string as a local-readable date+time. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

/**
 * Format a USDC value as `$1,234.56`.
 *
 * Two input shapes are accepted:
 *
 *   1. **Atomic** — bigint, integer string, or finite Number,
 *      interpreted as micro-USDC (6 decimals). This is the canonical
 *      shape on every API response (`totalCostBasisAtomic`,
 *      `tokensOut`, etc.). Formatted with bigint math so values past
 *      Number.MAX_SAFE_INTEGER round-trip exactly.
 *   2. **Decimal string** — only used by analytics endpoints that
 *      return human-formatted dollar amounts (e.g. `"1234.56"`).
 *      These pass through `Number.parseFloat`, which means values
 *      with more than ~15 significant decimal digits round at IEEE-754
 *      precision. This is acceptable for *display* (the underlying
 *      authoritative value is always atomic), but consumers writing
 *      reconciliation logic should call the upstream atomic field
 *      directly rather than re-parsing a formatted decimal.
 *
 * The atomic branch rounds the cents column **toward zero** (cheaper
 * than half-even for tables; the trade engine reconciles to atomic
 * precision elsewhere). Cosmetic only.
 */
export function formatUsdcAtomic(atomic: string | bigint | number): string {
  if (typeof atomic === 'string' && atomic.includes('.')) {
    // Decimal-string branch (analytics only). Documented loss: values
    // > 15 significant digits round at parseFloat precision.
    const n = Number.parseFloat(atomic);
    if (Number.isNaN(n)) return '$0.00';
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  let big: bigint;
  try {
    big = typeof atomic === 'bigint' ? atomic : BigInt(atomic);
  } catch {
    return '$0.00';
  }
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const wholeStr = whole.toLocaleString('en-US');
  const cents = (frac / 10_000n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${wholeStr}.${cents}`;
}

/**
 * Format a human USDC decimal string (e.g. `'12.5'`) as `$12.50`.
 * Used when the API hands back already-decimal amounts (the trade
 * resource's `amount` field).
 */
export function formatUsdcDecimal(value: string): string {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format a probability in [0,1] as a percentage string. */
export function formatProbability(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return '-';
  return `${(p * 100).toFixed(1)}%`;
}

/**
 * Generic fixed-point bigint→decimal-display formatter. Used by every
 * CLI helper that needs to render an atomic-units bigint (WAD-18,
 * gwei-9, ETH-18, USDC-6) as a human-readable decimal string.
 *
 * Two parameters control shape:
 *
 *   - `baseDecimals` — the unit's atomic precision (18 for WAD/ETH,
 *     9 for gwei, 6 for USDC).
 *   - `displayDecimals` — how many fractional digits to emit. Must
 *     be ≤ `baseDecimals`. Truncates rather than rounds — display
 *     only, `--json` preserves the full atomic-string precision.
 *
 * Sign is extracted before the magnitude split so `-` rendering
 * lives at one site. The whole part is rendered with thousand-
 * separator commas via `toLocaleString` (consistent with
 * `formatUsdcAtomic`); call sites that need the raw integer-shape
 * (e.g. `formatGwei`'s historical "no commas" form) opt out via
 * `thousandSeparator: false`.
 *
 * Accepts `string | bigint` for the same reason `formatWad` did:
 * direct-mode SDKs return `bigint`, indexer-backed views return
 * integer-string. The `try/catch` around `BigInt(value)` is the
 * defensive never-throw guarantee on display paths — a malformed
 * input falls through to the input itself rather than crashing.
 */
export function formatBigDecimal(
  value: string | bigint,
  options: { baseDecimals: number; displayDecimals: number; thousandSeparator?: boolean }
): string {
  const { baseDecimals, displayDecimals } = options;
  const useThousandSeparator = options.thousandSeparator ?? true;
  let big: bigint;
  try {
    big = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return typeof value === 'string' ? value : '0';
  }
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const baseScale = 10n ** BigInt(baseDecimals);
  const whole = abs / baseScale;
  const frac = abs % baseScale;
  const truncated = (frac / 10n ** BigInt(baseDecimals - displayDecimals))
    .toString()
    .padStart(displayDecimals, '0');
  const wholeStr = useThousandSeparator ? whole.toLocaleString('en-US') : whole.toString();
  return `${negative ? '-' : ''}${wholeStr}.${truncated}`;
}

/**
 * Format a WAD-18 (1e18) value as a 4-decimal token display string.
 * Twin of `formatUsdcAtomic` but for outcome-token quantities.
 * Direct-mode SDK returns bigint; indexer-backed views return string.
 */
export function formatWad(wad: string | bigint): string {
  return formatBigDecimal(wad, { baseDecimals: 18, displayDecimals: 4 });
}

/**
 * Format a wei bigint as a 3-decimal gwei display string. Used by
 * direct-mode commands that emit gas balances and fee estimates.
 * Truncates rather than rounds — fees are display-only and operators
 * who need exact wei should use `--json` (which preserves the bigint
 * as a decimal string).
 *
 * No thousand-separator on the whole part: the gwei convention in
 * the broader EVM ecosystem (etherscan, foundry, viem's display
 * helpers) renders bare integers, and operators piping our output
 * through `awk '{print $2 + 0}'` or similar rely on it.
 */
export function formatGwei(wei: bigint): string {
  return formatBigDecimal(wei, {
    baseDecimals: 9,
    displayDecimals: 3,
    thousandSeparator: false,
  });
}

/** Apply a status color (green/yellow/red/blue/gray) by status string. */
export function colorStatus(value: string | null | undefined): string {
  if (!value) return style.dim('-');
  switch (value.toUpperCase()) {
    case 'ACTIVE':
    case 'COMPLETED':
      return style.success(value);
    case 'EXECUTING':
    case 'VALIDATING':
    case 'PENDING':
      return style.cyan(value);
    case 'PENDING_CONFIRMATION':
      return style.warn(value);
    case 'RESOLVED':
      return style.info(value);
    case 'REJECTED':
    case 'FAILED':
      return style.error(value);
    case 'UNSEEDED':
    case 'FROZEN':
      return style.dim(value);
    default:
      return value;
  }
}

/** Build a cli-table3 with bold headers and consistent style. */
export function createTable(headers: string[]): Table.Table {
  return new Table({
    head: headers.map((h) => style.bold(h)),
    style: { head: [], border: [] },
  });
}
