/**
 * `kash markets get <id>` — fetch a single market.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
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
    print(`  ${style.dim('Chain      ')} ${String(market.chainId)}`);
    print(`  ${style.dim('Status     ')} ${colorStatus(market.status ?? 'UNKNOWN')}`);
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
