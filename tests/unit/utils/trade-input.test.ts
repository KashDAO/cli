/**
 * Unit tests for `utils/trade-input.ts`.
 *
 * These parsers are the load-bearing seam between user input and the
 * amounts `kash trade`, `kash quote` and `kash redeem` send — drift
 * here would silently mis-price real-money trades. Tests pin the
 * boundary behaviours explicitly so any regression breaks loud.
 */

import { describe, expect, it } from 'vitest';

import { CliValidationError } from '../../../src/errors.js';
import {
  decimalToAtomicUsdc,
  decimalToAtomicWad,
  parseOutcomeIndex,
  validateUsdcDecimalShape,
} from '../../../src/utils/trade-input.js';

describe('parseOutcomeIndex', () => {
  it('accepts the lower bound 0', () => {
    expect(parseOutcomeIndex('0')).toBe(0);
  });

  it('accepts the upper bound 7 (8-outcome AMM ceiling)', () => {
    expect(parseOutcomeIndex('7')).toBe(7);
  });

  it('throws when undefined (required flag)', () => {
    expect(() => parseOutcomeIndex(undefined)).toThrow(CliValidationError);
  });

  it('throws on negative integers', () => {
    expect(() => parseOutcomeIndex('-1')).toThrow(CliValidationError);
  });

  it('accepts the last outcome of a 100-outcome market', () => {
    // Markets carry 2-100 outcomes; 96-outcome markets exist. The old [0, 7]
    // ceiling refused every outcome past the eighth.
    expect(parseOutcomeIndex('8')).toBe(8);
    expect(parseOutcomeIndex('99')).toBe(99);
  });

  it('throws on values above 99 (off-by-one ceiling)', () => {
    expect(() => parseOutcomeIndex('100')).toThrow(CliValidationError);
  });

  it('throws on non-integers', () => {
    expect(() => parseOutcomeIndex('abc')).toThrow(CliValidationError);
  });

  // Pre-fix `parseInt('1.5', 10) === 1` and `parseInt('1e3', 10) === 1`
  // both silently truncated, accepting an obvious typo as a valid
  // outcome index. `--outcome 1.5` would buy outcome 1 — wrong outcome,
  // real-money loss. Now we reject the shape outright.
  it('rejects decimal input (1.5 → no longer silently rounds to 1)', () => {
    expect(() => parseOutcomeIndex('1.5')).toThrow(CliValidationError);
    expect(() => parseOutcomeIndex('2.0')).toThrow(CliValidationError);
  });

  it('rejects scientific notation (1e0 → no longer silently rounds to 1)', () => {
    expect(() => parseOutcomeIndex('1e0')).toThrow(CliValidationError);
    expect(() => parseOutcomeIndex('5e0')).toThrow(CliValidationError);
  });

  it('rejects whitespace, hex, and other non-bare-integer shapes', () => {
    expect(() => parseOutcomeIndex(' 1')).toThrow(CliValidationError);
    expect(() => parseOutcomeIndex('1 ')).toThrow(CliValidationError);
    expect(() => parseOutcomeIndex('0x1')).toThrow(CliValidationError);
  });
});

describe('decimalToAtomicUsdc — 6-decimal precision', () => {
  it('converts whole numbers', () => {
    expect(decimalToAtomicUsdc('10', 'amount')).toBe(10_000_000n);
  });

  it('converts decimals with full 6-digit precision', () => {
    expect(decimalToAtomicUsdc('0.000001', 'amount')).toBe(1n);
  });

  it('pads short fractional parts to 6 digits', () => {
    expect(decimalToAtomicUsdc('12.5', 'amount')).toBe(12_500_000n);
  });

  it('handles "0" cleanly', () => {
    expect(decimalToAtomicUsdc('0', 'amount')).toBe(0n);
  });

  it('throws on more than 6 fractional digits (precision-loss guard)', () => {
    expect(() => decimalToAtomicUsdc('1.1234567', 'amount')).toThrow(CliValidationError);
  });

  it('throws on negative input', () => {
    expect(() => decimalToAtomicUsdc('-1', 'amount')).toThrow(CliValidationError);
  });

  it('throws on non-numeric', () => {
    expect(() => decimalToAtomicUsdc('twelve fifty', 'amount')).toThrow(CliValidationError);
  });

  it('throws on scientific notation (regex rejects)', () => {
    expect(() => decimalToAtomicUsdc('1e3', 'amount')).toThrow(CliValidationError);
  });

  it('preserves the field name in the error envelope', () => {
    try {
      decimalToAtomicUsdc('NaN', 'min-out');
      expect.fail('expected throw');
    } catch (err) {
      const action = (err as CliValidationError).actions.find((a) => a.type === 'check_input');
      expect((action as { type: 'check_input'; field: string }).field).toBe('min-out');
    }
  });
});

describe('validateUsdcDecimalShape — shape-only validator', () => {
  // Used by `kash trade buy/sell` (public-API mode) which ships the
  // raw decimal string to the SDK rather than converting to atomic
  // units. Backed by the same regex `decimalToAtomicUsdc` uses, so
  // shape errors are identical across all three modes.
  it('accepts a whole number', () => {
    expect(() => validateUsdcDecimalShape('10', 'amount')).not.toThrow();
  });

  it('accepts decimals with up to 6 fractional digits', () => {
    expect(() => validateUsdcDecimalShape('12.50', 'amount')).not.toThrow();
    expect(() => validateUsdcDecimalShape('0.000001', 'amount')).not.toThrow();
  });

  it('throws on more than 6 fractional digits', () => {
    expect(() => validateUsdcDecimalShape('1.1234567', 'amount')).toThrow(CliValidationError);
  });

  it('throws on negative input', () => {
    expect(() => validateUsdcDecimalShape('-1', 'amount')).toThrow(CliValidationError);
  });

  it('throws on non-numeric', () => {
    expect(() => validateUsdcDecimalShape('twelve', 'amount')).toThrow(CliValidationError);
  });

  it('error envelope matches `decimalToAtomicUsdc` (same regex, same message)', () => {
    let shapeErr: CliValidationError | undefined;
    let convertErr: CliValidationError | undefined;
    try {
      validateUsdcDecimalShape('1.1234567', 'amount');
    } catch (e) {
      shapeErr = e as CliValidationError;
    }
    try {
      decimalToAtomicUsdc('1.1234567', 'amount');
    } catch (e) {
      convertErr = e as CliValidationError;
    }
    expect(shapeErr).toBeDefined();
    expect(convertErr).toBeDefined();
    expect(shapeErr!.message).toBe(convertErr!.message);
  });
});

describe('decimalToAtomicWad — 18-decimal precision', () => {
  it('converts whole tokens', () => {
    expect(decimalToAtomicWad('1', 'tokens')).toBe(10n ** 18n);
  });

  it('handles full 18-digit precision', () => {
    expect(decimalToAtomicWad('0.000000000000000001', 'tokens')).toBe(1n);
  });

  it('pads short fractional parts to 18 digits', () => {
    expect(decimalToAtomicWad('1.5', 'tokens')).toBe(15n * 10n ** 17n);
  });

  it('throws on more than 18 fractional digits', () => {
    expect(() => decimalToAtomicWad('1.0000000000000000001', 'tokens')).toThrow(CliValidationError);
  });

  it('throws on non-numeric', () => {
    expect(() => decimalToAtomicWad('lots', 'tokens')).toThrow(CliValidationError);
  });
});
