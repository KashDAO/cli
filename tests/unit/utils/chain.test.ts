import { describe, expect, it } from 'vitest';

import { marketChainLabel } from '../../../src/utils/chain.js';

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
