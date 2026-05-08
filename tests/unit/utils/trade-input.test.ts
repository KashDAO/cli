/**
 * Unit tests for `utils/trade-input.ts`.
 *
 * These parsers are the load-bearing seam between user input and the
 * SDK's atomic-unit math. SA mode (`kash protocol trade send`),
 * userop-build (`kash protocol userop build …`), and EOA mode
 * (`kash eoa trade send`) all funnel through this module — drift
 * here would silently mis-price real-money trades. Tests pin the
 * boundary behaviours explicitly so any regression breaks loud.
 */

import { describe, expect, it } from 'vitest';

import { CliValidationError } from '../../../src/errors.js';
import {
  DEFAULT_SLIPPAGE_BPS,
  HEX_ADDRESS_REGEX,
  HEX_HASH_REGEX,
  MAX_UINT256,
  decimalToAtomicUsdc,
  decimalToAtomicWad,
  extractPartialHash,
  parseDeadlineSec,
  parseOutcomeIndex,
  parseSlippageBps,
  parseUppercaseSide,
  validateAddress,
  validateAddressOptional,
  validateUsdcDecimalShape,
} from '../../../src/utils/trade-input.js';

describe('trade-input — exported constants', () => {
  it('DEFAULT_SLIPPAGE_BPS is 50 (0.5%)', () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50);
  });

  it('MAX_UINT256 is exactly 2^256 - 1', () => {
    expect(MAX_UINT256).toBe(2n ** 256n - 1n);
  });

  it('HEX_ADDRESS_REGEX matches a canonical 20-byte address', () => {
    expect(HEX_ADDRESS_REGEX.test('0x' + 'ab'.repeat(20))).toBe(true);
  });

  it('HEX_HASH_REGEX matches a canonical 32-byte hash', () => {
    expect(HEX_HASH_REGEX.test('0x' + 'cd'.repeat(32))).toBe(true);
  });
});

describe('validateAddress', () => {
  it('returns a typed `0x${string}` for a valid 20-byte address', () => {
    const out = validateAddress('0x' + 'a'.repeat(40), 'market');
    expect(out).toBe('0x' + 'a'.repeat(40));
  });

  it('accepts mixed-case hex', () => {
    expect(validateAddress('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', 'market')).toBe(
      '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    );
  });

  it('throws when too short', () => {
    expect(() => validateAddress('0x123', 'market')).toThrow(CliValidationError);
  });

  it('throws when too long (33-byte hex)', () => {
    expect(() => validateAddress('0x' + 'a'.repeat(42), 'market')).toThrow(CliValidationError);
  });

  it('throws when missing 0x prefix', () => {
    expect(() => validateAddress('a'.repeat(40), 'market')).toThrow(CliValidationError);
  });

  it('throws when contains non-hex characters', () => {
    expect(() => validateAddress('0x' + 'g'.repeat(40), 'market')).toThrow(CliValidationError);
  });

  it('throws on empty string', () => {
    expect(() => validateAddress('', 'market')).toThrow(CliValidationError);
  });

  it('preserves the field name in the thrown error envelope', () => {
    try {
      validateAddress('not-an-address', 'spender');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliValidationError);
      const action = (err as CliValidationError).actions.find((a) => a.type === 'check_input');
      expect(action).toBeDefined();
      expect((action as { type: 'check_input'; field: string }).field).toBe('spender');
    }
  });
});

describe('validateAddressOptional', () => {
  it('returns undefined for undefined input', () => {
    expect(validateAddressOptional(undefined, 'spender')).toBeUndefined();
  });

  it('validates and returns when input is present', () => {
    const addr = '0x' + 'b'.repeat(40);
    expect(validateAddressOptional(addr, 'spender')).toBe(addr);
  });

  it('throws on malformed input', () => {
    expect(() => validateAddressOptional('0xnope', 'spender')).toThrow(CliValidationError);
  });

  it('throws on empty string (treats it as a present-but-invalid value)', () => {
    expect(() => validateAddressOptional('', 'spender')).toThrow(CliValidationError);
  });
});

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

  it('throws on values above 7 (off-by-one ceiling)', () => {
    expect(() => parseOutcomeIndex('8')).toThrow(CliValidationError);
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

describe('parseSlippageBps', () => {
  it('accepts 0 (no slippage)', () => {
    expect(parseSlippageBps('0')).toBe(0);
  });

  it('accepts 10000 (100%)', () => {
    expect(parseSlippageBps('10000')).toBe(10_000);
  });

  it('accepts the default 50 (0.5%)', () => {
    expect(parseSlippageBps('50')).toBe(50);
  });

  it('throws above 10000', () => {
    expect(() => parseSlippageBps('10001')).toThrow(CliValidationError);
  });

  it('throws on negative input', () => {
    expect(() => parseSlippageBps('-1')).toThrow(CliValidationError);
  });

  it('throws on non-numeric', () => {
    expect(() => parseSlippageBps('half-a-percent')).toThrow(CliValidationError);
  });

  // Real-money pin: `parseInt('1e3', 10) === 1`. Pre-fix,
  // `--slippage-bps 1e3` would silently use 1 bps (0.01%) instead
  // of the 1000 (10%) the operator typed. That's catastrophic on
  // any volatile market — the trade would revert on minor swings
  // the user explicitly intended to absorb.
  it('rejects scientific notation (1e3 → no longer silently parses as 1 bps)', () => {
    expect(() => parseSlippageBps('1e3')).toThrow(CliValidationError);
    expect(() => parseSlippageBps('5E2')).toThrow(CliValidationError);
  });

  it('rejects decimal input', () => {
    expect(() => parseSlippageBps('50.5')).toThrow(CliValidationError);
    expect(() => parseSlippageBps('100.0')).toThrow(CliValidationError);
  });
});

describe('parseDeadlineSec', () => {
  it('accepts a small positive seconds value', () => {
    expect(parseDeadlineSec('1700000000')).toBe(1_700_000_000n);
  });

  it('accepts exactly Number.MAX_SAFE_INTEGER', () => {
    expect(parseDeadlineSec(String(Number.MAX_SAFE_INTEGER))).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('throws on zero (must be positive)', () => {
    expect(() => parseDeadlineSec('0')).toThrow(CliValidationError);
  });

  it('throws on negative', () => {
    expect(() => parseDeadlineSec('-1')).toThrow(CliValidationError);
  });

  it('throws on non-numeric', () => {
    expect(() => parseDeadlineSec('next-tuesday')).toThrow(CliValidationError);
  });

  it('throws above Number.MAX_SAFE_INTEGER (catches ms-vs-sec confusion)', () => {
    // Date.now() returns ms; passing it verbatim would be ~1700000000000 — well above MAX_SAFE_INTEGER if scaled.
    // Pick a value clearly above MAX_SAFE_INTEGER (~9e15) to pin the guard.
    const bigMs = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => parseDeadlineSec(bigMs)).toThrow(CliValidationError);
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

describe('parseUppercaseSide — case-insensitive BUY/SELL parser', () => {
  // Used by `kash protocol quote` (SA mode) and `kash eoa quote` (EOA
  // mode). Returns the canonical uppercase form the SDKs expect.
  // Different from the lowercase variant in `markets/predictions.ts`
  // (filter, not execute — separate API endpoint).
  it('returns uppercase for lowercase input', () => {
    expect(parseUppercaseSide('buy')).toBe('BUY');
    expect(parseUppercaseSide('sell')).toBe('SELL');
  });

  it('returns uppercase for already-uppercase input', () => {
    expect(parseUppercaseSide('BUY')).toBe('BUY');
    expect(parseUppercaseSide('SELL')).toBe('SELL');
  });

  it('accepts mixed case', () => {
    expect(parseUppercaseSide('Buy')).toBe('BUY');
    expect(parseUppercaseSide('sElL')).toBe('SELL');
  });

  it('throws on unknown side', () => {
    expect(() => parseUppercaseSide('long')).toThrow(CliValidationError);
  });

  it('throws on empty string', () => {
    expect(() => parseUppercaseSide('')).toThrow(CliValidationError);
  });

  it('uses the default `name` of "side" in the error envelope', () => {
    try {
      parseUppercaseSide('long');
      expect.fail('expected throw');
    } catch (err) {
      const action = (err as CliValidationError).actions.find((a) => a.type === 'check_input');
      expect((action as { type: 'check_input'; field: string }).field).toBe('side');
    }
  });

  it('honours an override `name` for callers using a different flag spelling', () => {
    try {
      parseUppercaseSide('?', 'direction');
      expect.fail('expected throw');
    } catch (err) {
      const action = (err as CliValidationError).actions.find((a) => a.type === 'check_input');
      expect((action as { type: 'check_input'; field: string }).field).toBe('direction');
    }
  });
});

describe('extractPartialHash — partial-completion discriminator factory', () => {
  // The factory is the canonical implementation behind the SA-mode
  // `extractPartialUserOpHash` and EOA-mode `extractPartialTransactionHash`
  // wrappers. Both wrappers narrow on a specific SDK error code BEFORE
  // reading `context.<contextKey>` so that error classes which share
  // the hash-shape but have different semantics (signer failure, RPC
  // failure) cannot masquerade as partial completions.
  const HASH = `0x${'a'.repeat(64)}` as const;

  it('returns the hash on a matching code + context shape (SA path)', () => {
    const cause = {
      name: 'KashBundlerError',
      code: 'BUNDLER_RECEIPT_TIMEOUT',
      context: { userOpHash: HASH },
    };
    expect(
      extractPartialHash(cause, { code: 'BUNDLER_RECEIPT_TIMEOUT', contextKey: 'userOpHash' })
    ).toBe(HASH);
  });

  it('returns the hash on a matching code + context shape (EOA path)', () => {
    const cause = {
      name: 'KashChainError',
      code: 'WAIT_RECEIPT_FAILED',
      context: { transactionHash: HASH, chainId: 8453 },
    };
    expect(
      extractPartialHash(cause, {
        code: 'WAIT_RECEIPT_FAILED',
        contextKey: 'transactionHash',
      })
    ).toBe(HASH);
  });

  it('returns undefined when the code does NOT match (signer failure counter-test)', () => {
    // KashSignerError carries `context.userOpHash` too — the discriminator
    // must reject this case so signer failures aren't mis-reported as
    // "submit succeeded, wait timed out".
    const cause = {
      name: 'KashSignerError',
      code: 'SIGNER_SIGN_FAILED',
      context: { ownerAddress: '0xowner', userOpHash: HASH },
    };
    expect(
      extractPartialHash(cause, { code: 'BUNDLER_RECEIPT_TIMEOUT', contextKey: 'userOpHash' })
    ).toBeUndefined();
  });

  it('returns undefined when context is missing', () => {
    const cause = { code: 'BUNDLER_RECEIPT_TIMEOUT' };
    expect(
      extractPartialHash(cause, { code: 'BUNDLER_RECEIPT_TIMEOUT', contextKey: 'userOpHash' })
    ).toBeUndefined();
  });

  it('returns undefined when contextKey is absent on context', () => {
    const cause = {
      code: 'WAIT_RECEIPT_FAILED',
      context: { chainId: 8453 }, // no transactionHash
    };
    expect(
      extractPartialHash(cause, {
        code: 'WAIT_RECEIPT_FAILED',
        contextKey: 'transactionHash',
      })
    ).toBeUndefined();
  });

  it('returns undefined when the hash field is malformed (regex rejection)', () => {
    const cause = {
      code: 'BUNDLER_RECEIPT_TIMEOUT',
      context: { userOpHash: '0xnotahash' },
    };
    expect(
      extractPartialHash(cause, { code: 'BUNDLER_RECEIPT_TIMEOUT', contextKey: 'userOpHash' })
    ).toBeUndefined();
  });

  it('returns undefined for non-object causes', () => {
    expect(
      extractPartialHash(null, { code: 'BUNDLER_RECEIPT_TIMEOUT', contextKey: 'userOpHash' })
    ).toBeUndefined();
    expect(
      extractPartialHash(undefined, {
        code: 'BUNDLER_RECEIPT_TIMEOUT',
        contextKey: 'userOpHash',
      })
    ).toBeUndefined();
    expect(
      extractPartialHash('an error message', {
        code: 'BUNDLER_RECEIPT_TIMEOUT',
        contextKey: 'userOpHash',
      })
    ).toBeUndefined();
  });

  it('returns undefined for a generic Error (no code, no context)', () => {
    const cause = new Error('something exploded pre-submit');
    expect(
      extractPartialHash(cause, { code: 'BUNDLER_RECEIPT_TIMEOUT', contextKey: 'userOpHash' })
    ).toBeUndefined();
  });
});
