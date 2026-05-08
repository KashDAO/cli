/**
 * `kash portfolio` — read-only snapshot of the authenticating user's
 * positions and aggregate cost basis.
 */

import { Command } from 'commander';

import { positionsCommand } from './positions.js';
import { showPortfolioCommand } from './show.js';

export const portfolioCommand = new Command('portfolio')
  .description('View your portfolio.')
  .addCommand(showPortfolioCommand)
  .addCommand(positionsCommand);
