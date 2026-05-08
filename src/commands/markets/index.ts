/**
 * `kash markets` — read-only market queries.
 *
 * Subcommands: `list`, `get`, `predictions`. All require an API key
 * with `markets:read` scope (granted by default on every tier). Quotes
 * are a separate command group (`kash quote buy|sell`) under the
 * `markets:quote` scope, split so customers can throttle RPC-heavy
 * quote traffic independently from cheap market reads.
 */

import { Command } from 'commander';

import { getMarketCommand } from './get.js';
import { listMarketsCommand } from './list.js';
import { predictionsCommand } from './predictions.js';

export const marketsCommand = new Command('markets')
  .description('List and inspect prediction markets.')
  .addCommand(listMarketsCommand)
  .addCommand(getMarketCommand)
  .addCommand(predictionsCommand);
