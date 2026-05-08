/**
 * `kash portfolio show` — aggregate summary for the authenticating
 * user's smart account.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { formatAddress, formatUsdcAtomic } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';

export const showPortfolioCommand = new Command('show')
  .description('Show the aggregate portfolio summary.')
  .addHelpText(
    'after',
    `
Examples:
  $ kash portfolio show
  $ kash portfolio show --json --quiet | jq -r '.smartAccountAddress'
`
  )
  .action(async (_opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    let portfolio;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      portfolio = await client.portfolio.get();
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(portfolio);
      return;
    }

    print('');
    print(
      `  ${style.dim('Smart account ')} ${formatAddress(portfolio.smartAccountAddress, 10, 8)}`
    );
    print(`  ${style.dim('Active        ')} ${String(portfolio.activePositions)} positions`);
    print(`  ${style.dim('Cost basis    ')} ${formatUsdcAtomic(portfolio.totalCostBasisAtomic)}`);
  });
