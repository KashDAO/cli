/**
 * Display formatters: USDC, addresses, IDs, probability, status colors.
 *
 * The atomic-USDC formatter is exercised at boundaries (zero, the
 * 1e6/1e9 cliffs, and a precision pinhole that would overflow Number).
 */

import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import {
  colorStatus,
  formatBigDecimal,
  formatAddress,
  formatProbability,
  formatUsdcAtomic,
  formatUsdcDecimal,
  formatWad,
  shortId,
} from '../../../src/utils/formatting.js';

describe('shortId', () => {
  it('truncates long ids with an ellipsis', () => {
    expect(shortId('abcdef0123456789', 6)).toBe('abcdef...');
  });

  it('passes short ids through unchanged', () => {
    expect(shortId('abc', 6)).toBe('abc');
  });
});

describe('formatAddress', () => {
  it('shortens evm addresses', () => {
    expect(formatAddress('0x1234567890abcdef1234567890abcdef12345678', 6, 4)).toBe('0x1234...5678');
  });

  it('passes already-short values through', () => {
    expect(formatAddress('0xabcd', 6, 4)).toBe('0xabcd');
  });
});

describe('formatUsdcAtomic', () => {
  it('formats zero as $0.00', () => {
    expect(formatUsdcAtomic('0')).toBe('$0.00');
  });

  it('formats whole-dollar values', () => {
    expect(formatUsdcAtomic('1000000')).toBe('$1.00');
    expect(formatUsdcAtomic('1500000')).toBe('$1.50');
    expect(formatUsdcAtomic('100000000')).toBe('$100.00');
  });

  it('handles values larger than Number.MAX_SAFE_INTEGER', () => {
    // 1 trillion USDC → 1e18 atomic; well past Number precision.
    const atomic = (1_000_000_000_000n * 1_000_000n).toString();
    expect(formatUsdcAtomic(atomic)).toBe('$1,000,000,000,000.00');
  });

  it('formats negative values', () => {
    expect(formatUsdcAtomic('-2500000')).toBe('-$2.50');
  });

  it('falls back gracefully for non-numeric input', () => {
    expect(formatUsdcAtomic('xyz')).toBe('$0.00');
  });

  it('handles decimal-string analytics values', () => {
    expect(formatUsdcAtomic('1234.5')).toBe('$1,234.50');
  });
});

describe('formatUsdcDecimal', () => {
  it('formats human decimal strings', () => {
    expect(formatUsdcDecimal('10')).toBe('$10.00');
    expect(formatUsdcDecimal('12.5')).toBe('$12.50');
  });
});

describe('formatProbability', () => {
  it('renders fractions as percentages', () => {
    expect(formatProbability(0.5)).toBe('50.0%');
    expect(formatProbability(0.123)).toBe('12.3%');
  });

  it('handles null gracefully', () => {
    expect(formatProbability(null)).toBe('-');
    expect(formatProbability(undefined)).toBe('-');
  });
});

describe('colorStatus', () => {
  // Color disabled at the chalk level so the assertions are stable.
  const previousLevel = chalk.level;
  chalk.level = 0;

  it('returns the value verbatim for known statuses', () => {
    expect(colorStatus('ACTIVE')).toBe('ACTIVE');
    expect(colorStatus('FAILED')).toBe('FAILED');
    expect(colorStatus(null)).toBe('-');
  });

  // Restore for any other tests that might run later.
  chalk.level = previousLevel;
});

describe('formatWad — 18-decimal token quantities', () => {
  // `formatWad` is the WAD-18 twin of `formatUsdcAtomic` (6dp). It is
  // used by every command that displays outcome tokens, so wrong
  // rounding or sign handling would mis-render real balances. Tests
  // exercise both bigint and string entry points (computed values are
  // bigint; the API's atomic amounts are integer-strings) and the boundaries where Number precision would
  // silently lose data.
  it('formats zero as "0.0000"', () => {
    expect(formatWad(0n)).toBe('0.0000');
  });

  it('formats one whole token (1e18) as "1.0000"', () => {
    expect(formatWad(10n ** 18n)).toBe('1.0000');
  });

  it('formats 1.5 tokens with truncation to 4 decimals', () => {
    expect(formatWad(1_500_000_000_000_000_000n)).toBe('1.5000');
  });

  it('truncates fractional digits past the 4th rather than rounding', () => {
    // 1.99999... stays at 1.9999 (round-down — display only).
    const wad = 1_999_999_999_999_999_999n;
    expect(formatWad(wad)).toBe('1.9999');
  });

  it('handles negative values with a leading minus sign', () => {
    expect(formatWad(-(10n ** 18n))).toBe('-1.0000');
  });

  it('preserves precision past Number.MAX_SAFE_INTEGER (bigint path)', () => {
    // 12345.6789 worth of tokens: 12345 * 1e18 + 6789 * 1e14
    const wad = 12_345n * 10n ** 18n + 6789n * 10n ** 14n;
    expect(formatWad(wad)).toBe('12,345.6789');
  });

  it('accepts string input (indexer path)', () => {
    expect(formatWad('1500000000000000000')).toBe('1.5000');
  });

  it('handles very large quantities with thousand-separator', () => {
    // 1,000,000 tokens
    const wad = 1_000_000n * 10n ** 18n;
    expect(formatWad(wad)).toBe('1,000,000.0000');
  });

  it('returns the input string when string is not a valid bigint', () => {
    // The defensive fallback — never throws on display paths.
    expect(formatWad('not-a-number')).toBe('not-a-number');
  });
});

describe('formatBigDecimal agrees with the canonical primitive', () => {
  /**
   * `@kashdao/utils`' `formatAtomicUnits` is the canonical fixed-point
   * formatter; this file is its published twin, exempted from
   * `one-atomic-formatter` precisely because it "already has its own exact,
   * sign-safe primitive in `formatBigDecimal`". The two disagreed on the same
   * inputs until 2026-09-09:
   *
   * | (baseDecimals, displayDecimals) | formatAtomicUnits | this, before   |
   * | ------------------------------- | ----------------- | -------------- |
   * | 6, 8                            | `12.500000`       | **RangeError** |
   * | 6, 0                            | `12`              | `12.0`         |
   *
   * The throw is the one that mattered: the exponent went negative, and that
   * expression sits OUTSIDE the `try` guarding the `BigInt(value)` parse.
   */
  it('clamps displayDecimals to the unit rather than throwing', () => {
    // `10n ** BigInt(6 - 8)` used to raise RangeError from a display path.
    expect(formatBigDecimal(12_500_000n, { baseDecimals: 6, displayDecimals: 8 })).toBe(
      '12.500000'
    );
  });

  it('drops the decimal point when no fractional digits are shown', () => {
    // `12.0` claims a precision the caller asked not to see.
    expect(formatBigDecimal(12_500_000n, { baseDecimals: 6, displayDecimals: 0 })).toBe('12');
    expect(formatBigDecimal(12_500_000n, { baseDecimals: 0, displayDecimals: 4 })).toBe(
      '12,500,000'
    );
  });

  it('is unchanged for every shape a caller actually passes — regression', () => {
    // formatWad 18/4, plus the 9/3 and 18/6 shapes. If the clamp had
    // altered any of these, the alignment would be a behaviour change rather
    // than a repair.
    expect(
      formatBigDecimal(1_500_000_000_000_000_000n, { baseDecimals: 18, displayDecimals: 4 })
    ).toBe('1.5000');
    expect(
      formatBigDecimal(1_500_000_000n, {
        baseDecimals: 9,
        displayDecimals: 3,
        thousandSeparator: false,
      })
    ).toBe('1.500');
    expect(
      formatBigDecimal(1_500_000_000_000_000_000n, { baseDecimals: 18, displayDecimals: 6 })
    ).toBe('1.500000');
  });

  it('keeps the sign on one side of the point', () => {
    // The `-3.-5` shape the shared primitive's docblock records three copies of.
    expect(formatBigDecimal(-3_500_000n, { baseDecimals: 6, displayDecimals: 2 })).toBe('-3.50');
    expect(formatBigDecimal(-500_000n, { baseDecimals: 6, displayDecimals: 2 })).toBe('-0.50');
  });
});
