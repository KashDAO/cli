/**
 * Chain references in the CLI.
 *
 * A profile names its chain with a chain reference rather than a numeric
 * chain id, because a number cannot name Solana — Kash's canonical chain since
 * the 2026-10-01 cutover. Parsing is `@kashdao/sdk`'s `tryParseChainRef`, so
 * the CLI and the SDK agree on what a reference is.
 *
 * Stored and printed in the spelling the API returns: `evm:<chainId>` and
 * `solana:<cluster>`. The CAIP-2 `eip155:<chainId>` and a bare legacy number
 * (`8453`, how 0.1.x stored it) are accepted on input and normalised to `evm:`.
 * Both directions go through the SDK (`tryParseChainRef` / `formatChainRef`),
 * so there is one implementation of what a reference is and how it is spelled.
 */

import { formatChainRef, tryParseChainRef } from '@kashdao/sdk';

/**
 * Base mainnet. `kash protocol` and `kash eoa` drive the EVM protocol SDK
 * (ERC-4337 / viem) and fall back to it when the profile names a Solana chain.
 */
const BASE_MAINNET_CHAIN_ID = 8453;

const LEGACY_NUMERIC_CHAIN_ID = /^[1-9]\d*$/;

/**
 * Normalise user or file input to the API spelling (`evm:8453`,
 * `solana:devnet`), or `undefined` when it names no chain. Accepts
 * `solana:<cluster>`, `evm:<id>`, `eip155:<id>`, and a bare positive integer
 * as a legacy EVM chain id.
 */
export function normaliseChainInput(input: string): string | undefined {
  const value = input.trim();
  const ref = tryParseChainRef(LEGACY_NUMERIC_CHAIN_ID.test(value) ? `evm:${value}` : value);
  return ref === undefined ? undefined : formatChainRef(ref);
}

/**
 * The EVM chain id `kash protocol` / `kash eoa` run on: the profile's chain
 * when it is an EVM chain, otherwise Base mainnet. Those namespaces wrap the
 * EVM-only `@kashdao/protocol-sdk`, so a Solana default cannot drive them.
 */
export function protocolEvmChainId(defaultChain: string): number {
  const ref = tryParseChainRef(defaultChain);
  return ref?.type === 'evm' ? ref.chainId : BASE_MAINNET_CHAIN_ID;
}

/**
 * Whether the profile's chain is an EVM chain — the precondition for a
 * `customChain` block, which describes EVM contracts on an EVM network.
 */
export function isEvmChain(defaultChain: string): boolean {
  return tryParseChainRef(defaultChain)?.type === 'evm';
}

/**
 * How a market's chain is displayed: its `chainRef` (API version 2026-08-19)
 * or, on an older pin that sends only `chainId`, the equivalent `evm:<id>`.
 */
export function marketChainLabel(market: {
  readonly chainRef?: string | undefined;
  readonly chainId?: number | undefined;
}): string {
  if (market.chainRef !== undefined) return market.chainRef;
  if (market.chainId !== undefined) return `evm:${market.chainId}`;
  return '(unknown)';
}
