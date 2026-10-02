import { describe, expect, it } from 'vitest';

import {
  isEvmChain,
  marketChainLabel,
  normaliseChainInput,
  protocolEvmChainId,
} from '../../../src/utils/chain.js';

describe('normaliseChainInput', () => {
  it.each([
    ['solana:mainnet-beta', 'solana:mainnet-beta'],
    ['solana:devnet', 'solana:devnet'],
    ['evm:8453', 'evm:8453'],
    ['eip155:8453', 'evm:8453'],
    ['8453', 'evm:8453'],
    ['84532', 'evm:84532'],
    ['  eip155:31337 ', 'evm:31337'],
  ])('%j → %j', (input, expected) => {
    expect(normaliseChainInput(input)).toBe(expected);
  });

  it.each(['', 'base', 'solana:mainnet', '0', '08453', 'evm:9000001', '-1', 'eip155:0x2105'])(
    'refuses %j',
    (input) => {
      expect(normaliseChainInput(input)).toBeUndefined();
    }
  );
});

describe('normaliseChainInput — revert-check', () => {
  it('never stores the CAIP-2 spelling: a parser that echoed its input would fail here', () => {
    // Discriminating case for the evm: decision. Accepting eip155: on input is
    // only half of it; the stored value must be the API spelling, or a config
    // value and a market's chainRef stop comparing equal.
    const stored = normaliseChainInput('eip155:8453');
    expect(stored).toBe('evm:8453');
    expect(stored).not.toBe('eip155:8453');
  });
});

describe('protocolEvmChainId', () => {
  it('uses the profile chain when it is an EVM chain', () => {
    expect(protocolEvmChainId('evm:84532')).toBe(84532);
  });

  it('falls back to Base mainnet for a Solana profile', () => {
    expect(protocolEvmChainId('solana:mainnet-beta')).toBe(8453);
  });
});

describe('isEvmChain', () => {
  it('tells an EVM chain from a Solana one', () => {
    expect(isEvmChain('evm:31337')).toBe(true);
    expect(isEvmChain('solana:devnet')).toBe(false);
  });
});

describe('marketChainLabel', () => {
  it('prefers chainRef', () => {
    expect(marketChainLabel({ chainRef: 'solana:mainnet-beta' })).toBe('solana:mainnet-beta');
  });

  it('renders a bare chainId in the API spelling', () => {
    expect(marketChainLabel({ chainId: 8453 })).toBe('evm:8453');
  });

  it('never renders "undefined"', () => {
    expect(marketChainLabel({})).toBe('(unknown)');
  });
});
