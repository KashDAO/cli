/**
 * `kash portfolio positions` — per-position breakdown for the
 * authenticating user's smart account.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import {
  createTable,
  formatDate,
  formatUsdcAtomic,
  formatWad,
  shortId,
} from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson } from '../../utils/output.js';

type PositionsOptions = {
  market?: string;
};

export const positionsCommand = new Command('positions')
  .description('List active positions.')
  .option('-m, --market <id>', 'filter by market id')
  .addHelpText(
    'after',
    `
Examples:
  $ kash portfolio positions
  $ kash portfolio positions --market 9f0b...
  $ kash portfolio positions --json --quiet | jq '.data[] | select(.shares != "0")'
`
  )
  .action(async (options: PositionsOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    let positions;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      positions = await client.portfolio.positions(
        options.market === undefined ? {} : { marketId: options.market }
      );
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      // Canonical list-envelope shape `{data, pagination, count}` —
      // matches `markets list / trade list / webhooks list /
      // markets predictions`. Positions is non-paginated server-side
      // (full set returned in one call), so pagination always carries
      // terminal values; the field is present for shape parity so
      // agents can pin one schema across every list-shaped command.
      printJson({
        data: positions,
        pagination: { hasMore: false, cursor: null },
        count: positions.length,
      });
      return;
    }

    if (positions.length === 0) {
      log.info('No positions found.');
      return;
    }

    const table = createTable(['Market', 'Out#', 'Shares (WAD)', 'Cost basis', 'Trades', 'Last']);
    for (const p of positions) {
      table.push([
        shortId(p.marketId),
        String(p.outcomeIndex),
        formatWad(p.shares),
        formatUsdcAtomic(p.costBasisAtomic),
        String(p.tradeCount),
        formatDate(p.lastTradeAt),
      ]);
    }
    print(table.toString());
  });
