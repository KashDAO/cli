/**
 * How the CLI displays a market's chain.
 *
 * From API version `2026-08-19` every market names its chain with
 * `chainRef` (`solana:mainnet-beta`, `solana:devnet`); an older pin sends
 * only a numeric `chainId`, rendered in the same `evm:<id>` spelling the API
 * uses for it.
 */

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
