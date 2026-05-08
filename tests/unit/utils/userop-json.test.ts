/**
 * Unit tests for `utils/userop-json.ts`.
 *
 * `serializeUserOp` is the load-bearing primitive that lets a UserOp
 * round-trip from `kash protocol trade --print-userop` through an
 * external signer back into `kash protocol userop submit`. Its
 * inverse — `deserializeUserOp` — lives in `commands/protocol/userop.ts`
 * next to the bigint-field whitelist that drives it. These tests pin
 * the encoder's contract so any drift between the encoder's "stringify
 * every bigint" rule and the decoder's "decode these specific fields"
 * whitelist surfaces at test time, not at signing time.
 */

import { describe, expect, it } from 'vitest';

import { serializeUserOp } from '../../../src/utils/userop-json.js';

describe('serializeUserOp — bigint encoding', () => {
  it('coerces every bigint field to its decimal string representation', () => {
    const out = serializeUserOp({
      nonce: 0n,
      callGasLimit: 100_000n,
      verificationGasLimit: 200_000n,
      preVerificationGas: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      paymasterVerificationGasLimit: 50_000n,
      paymasterPostOpGasLimit: 30_000n,
    });
    expect(out).toEqual({
      nonce: '0',
      callGasLimit: '100000',
      verificationGasLimit: '200000',
      preVerificationGas: '21000',
      maxFeePerGas: '1000000000',
      maxPriorityFeePerGas: '100000000',
      paymasterVerificationGasLimit: '50000',
      paymasterPostOpGasLimit: '30000',
    });
  });

  it('preserves precision for values past Number.MAX_SAFE_INTEGER', () => {
    const big = 12_345_678_901_234_567_890n;
    const out = serializeUserOp({ nonce: big });
    expect(out['nonce']).toBe('12345678901234567890');
    // Round-trip parity check — the decoder's `BigInt(str)` would
    // recover the exact value, which is the contract that matters.
    expect(BigInt(out['nonce'] as string)).toBe(big);
  });

  it('passes hex / address / bytes fields through unchanged', () => {
    const userOp = {
      sender: '0x1234567890abcdef1234567890abcdef12345678',
      callData: '0xdeadbeef',
      signature: '0x',
      paymaster: '0xabcdef0123456789abcdef0123456789abcdef01',
      paymasterData: '0x',
      factory: undefined,
      factoryData: undefined,
    };
    expect(serializeUserOp(userOp)).toEqual(userOp);
  });

  it('handles a mixed envelope (bigints + strings + undefined)', () => {
    const out = serializeUserOp({
      sender: '0xabc',
      nonce: 7n,
      callData: '0x00',
      maxFeePerGas: 42n,
      paymaster: undefined,
    });
    expect(out).toEqual({
      sender: '0xabc',
      nonce: '7',
      callData: '0x00',
      maxFeePerGas: '42',
      paymaster: undefined,
    });
  });

  it('returns an empty object for an empty input (defensive boundary)', () => {
    expect(serializeUserOp({})).toEqual({});
  });

  it('emits new objects (does not mutate the input)', () => {
    const input = { nonce: 1n, sender: '0xdead' };
    const out = serializeUserOp(input);
    expect(out).not.toBe(input);
    // Original input unchanged.
    expect(input.nonce).toBe(1n);
    expect(typeof input.nonce).toBe('bigint');
  });

  it('round-trips with BigInt(): every emitted bigint string parses back to the original', () => {
    const original = {
      nonce: 0n,
      callGasLimit: 100_000n,
      verificationGasLimit: 200_000n,
      preVerificationGas: 21_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      paymasterVerificationGasLimit: 50_000n,
      paymasterPostOpGasLimit: 30_000n,
    };
    const serialized = serializeUserOp(original);
    for (const [k, v] of Object.entries(original)) {
      expect(BigInt(serialized[k] as string)).toBe(v);
    }
  });

  it('survives JSON.stringify / JSON.parse without losing data', () => {
    const original = serializeUserOp({
      nonce: 99n,
      sender: '0xdead',
      callGasLimit: 100_000n,
    });
    const reparsed = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    expect(reparsed).toEqual(original);
  });
});
