/**
 * `kash quote` — on-chain AMM price quotes.
 *
 * Wraps the SDK's `quotes` sub-client. Requires API key with the
 * `markets:quote` scope (granted by default on every tier; split from
 * `markets:read` because quotes are RPC-heavy and customers may want
 * to throttle quote traffic independently). Both subcommands accept
 * human decimals (USDC for buys, outcome tokens for sells) and
 * convert to the SDK's atomic-6 / WAD-18 wire format.
 */

import { Command } from 'commander';

import { buyQuoteCommand } from './buy.js';
import { sellQuoteCommand } from './sell.js';

export const quoteCommand = new Command('quote')
  .description('Get on-chain AMM price quotes (requires `markets:quote` scope).')
  .addCommand(buyQuoteCommand)
  .addCommand(sellQuoteCommand);
