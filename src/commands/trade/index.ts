/**
 * `kash trade` — place and manage trades.
 *
 * Every subcommand requires authentication: trades are written to a
 * specific actor (user or organization) determined by the API key's
 * scope. The buy/sell helpers honor `--wait` so scripts can block on
 * settlement without rolling their own poller.
 */

import { Command } from 'commander';

import { buyCommand } from './buy.js';
import { confirmCommand } from './confirm.js';
import { listTradesCommand } from './list.js';
import { sellCommand } from './sell.js';
import { statusCommand } from './status.js';

export const tradeCommand = new Command('trade')
  .description('Place trades and inspect their status.')
  .addCommand(buyCommand)
  .addCommand(sellCommand)
  .addCommand(statusCommand)
  .addCommand(listTradesCommand)
  .addCommand(confirmCommand);
