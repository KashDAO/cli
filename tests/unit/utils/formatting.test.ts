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
  formatAddress,
  formatGwei,
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
  // used by every protocol-mode read command that displays outcome
  // tokens, so wrong rounding or sign handling would mis-render real
  // balances. Tests exercise both bigint and string entry points
  // (direct-mode SDK returns bigint; indexer-backed views return
  // integer-string) and the boundaries where Number precision would
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

describe('formatGwei — wei to gwei display', () => {
  it('formats zero', () => {
    expect(formatGwei(0n)).toBe('0.000');
  });

  it('formats one gwei (1e9 wei) as "1.000"', () => {
    expect(formatGwei(10n ** 9n)).toBe('1.000');
  });

  it('truncates fractional digits past the 3rd rather than rounding', () => {
    // 1.999999999 gwei stays at 1.999.
    expect(formatGwei(1_999_999_999n)).toBe('1.999');
  });

  it('handles values below 1 gwei with leading-zero padding', () => {
    // 0.001 gwei = 1e6 wei
    expect(formatGwei(1_000_000n)).toBe('0.001');
  });

  it('handles negative wei (rare but supported)', () => {
    expect(formatGwei(-(10n ** 9n))).toBe('-1.000');
  });

  it('handles a large wei value that would overflow Number', () => {
    // 1e30 wei = 1e21 gwei
    const wei = 10n ** 30n;
    expect(formatGwei(wei)).toBe('1000000000000000000000.000');
  });
});
