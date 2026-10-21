/**
 * `kash markets get <id>` — fetch a single market.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { marketChainLabel } from '../../utils/chain.js';
import { buildClient } from '../../utils/client.js';
import {
  colorStatus,
  createTable,
  formatAddress,
  formatDate,
  formatProbability,
} from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';

import type { MarketResource } from '@kashdao/sdk';

export const getMarketCommand = new Command('get')
  .description('Fetch a single market by id.')
  .argument('<id>', 'market UUID')
  .addHelpText(
    'after',
    `
Examples:
  $ kash markets get 9f0b...
  $ kash markets get 9f0b... --json | jq '.outcomes'
  $ kash markets get 9f0b... --json --quiet | jq -r '.outcomes[].label'  # agent shape
  $ kash markets get 9f0b... --fields id,status,resolvedOutcomeIndex --json --quiet
`
  )
  .action(async (id: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    let market;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      market = await client.markets.get(id);
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(market);
      return;
    }

    print('');
    print(`${style.bold(market.title ?? '(untitled)')}`);
    print(`  ${style.dim('ID         ')} ${market.id}`);
    print(`  ${style.dim('Contract   ')} ${formatAddress(market.contractAddress)}`);
    print(`  ${style.dim('Chain      ')} ${marketChainLabel(market)}`);
    print(`  ${style.dim('Status     ')} ${colorStatus(market.status ?? 'UNKNOWN')}`);
    if (market.tradeable !== undefined) {
      print(`  ${style.dim('Tradeable  ')} ${formatTradeable(market)}`);
    }
    print(`  ${style.dim('Outcomes   ')} ${String(market.outcomeCount)}`);
    print(`  ${style.dim('Created    ')} ${formatDate(market.createdAt)}`);
    if (market.expiresAt) {
      print(`  ${style.dim('Expires    ')} ${formatDate(market.expiresAt)}`);
    }
    if (market.resolvedAt) {
      print(`  ${style.dim('Resolved   ')} ${formatDate(market.resolvedAt)}`);
    }
    if (market.description) {
      print('');
      print(market.description);
    }

    print('');
    const table = createTable(['#', 'Outcome', 'Probability']);
    for (const outcome of market.outcomes) {
      table.push([String(outcome.index), outcome.label, formatProbability(outcome.probability)]);
    }
    print(table.toString());
  });

/**
 * `yes`, or `no (<reason>)`. `status` stays ACTIVE for a cancelled or frozen
 * market, so this is the line that says whether a trade would be accepted.
 */
function formatTradeable(market: Pick<MarketResource, 'tradeable' | 'notTradeableReason'>): string {
  if (market.tradeable === true) return style.success('yes');
  return style.warn(`no (${market.notTradeableReason ?? 'unknown'})`);
}
