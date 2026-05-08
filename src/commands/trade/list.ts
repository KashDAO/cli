/**
 * `kash trade list` — list the authenticating user's trades.
 *
 * Status filter is forwarded as-is to the API (the API accepts
 * comma-separated multiplicities, e.g. `pending,completed`).
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { colorStatus, createTable, formatUsdcDecimal, shortId } from '../../utils/formatting.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, writeNdjson } from '../../utils/output.js';

import type { TradeResource } from '@kashdao/sdk';

type ListOptions = {
  status?: readonly string[];
  market?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  ndjson?: boolean;
};

export const listTradesCommand = new Command('list')
  .description('List your trades.')
  .option(
    '-s, --status <status...>',
    'status filter; repeat or comma-separate (e.g. --status pending --status executing | --status pending,executing)'
  )
  .option('-m, --market <id>', 'filter by market id')
  .option('-l, --limit <n>', 'page size (1-100)', '20')
  .option('-c, --cursor <cursor>', 'pagination cursor')
  .option('-a, --all', 'walk every page (use with --json for export)')
  .option(
    '--ndjson',
    'stream results as newline-delimited JSON (one record per line); implies --all'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash trade list
  $ kash trade list --status pending,executing --json --quiet
  $ kash trade list --status pending --status executing --json --quiet
  $ kash trade list --market 9f0b... --json --quiet | jq '.data[] | select(.status=="completed")'
  $ kash trade list --all --ndjson | while read -r line; do echo "$line" | jq -r .id; done
`
  )
  .action(async (options: ListOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const limit = options.limit === undefined ? 20 : parsePositiveInt(options.limit, 'limit');
    if (limit < 1 || limit > 100) {
      throw new CliValidationError('--limit must be between 1 and 100.', undefined, 'limit');
    }

    // Normalise --status: accept both `--status a,b,c` (single comma-string)
    // and `--status a --status b` (repeated). Both collapse to the
    // same comma-string the API expects. Mirrors `webhooks list`.
    const status = normaliseStatus(options.status);

    let response;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      response = await client.trades.list({
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(status === undefined ? {} : { status }),
        ...(options.market === undefined ? {} : { marketId: options.market }),
      });

      if (options.ndjson) {
        for await (const trade of response) {
          writeNdjson(trade);
        }
        return;
      }

      if (options.all) {
        const collected: TradeResource[] = [];
        for await (const trade of response) collected.push(trade);
        if (globals.json) {
          // Canonical `{data, pagination, count}` — see markets/list.ts
          // for rationale. Same shape across single-page and walked
          // modes lets agents pin to one schema.
          printJson({
            data: collected,
            pagination: { hasMore: false, cursor: null },
            count: collected.length,
          });
        } else {
          renderTable(collected);
        }
        return;
      }
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson({
        data: response.data,
        pagination: response.pagination,
        count: response.data.length,
      });
      return;
    }

    if (response.data.length === 0) {
      log.info('No trades matched the filter.');
      return;
    }
    renderTable(response.data);

    if (response.pagination.hasMore && response.pagination.cursor) {
      log.detail('Next page', `--cursor ${response.pagination.cursor}`);
    }
  });

/**
 * Flatten + dedupe `--status`. Each entry may itself be a comma list.
 * Returns the canonical comma-string the API expects, or `undefined`
 * when no values were supplied (preserving the "no filter" default).
 */
function normaliseStatus(raw: readonly string[] | undefined): string | undefined {
  if (!raw || raw.length === 0) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    for (const piece of entry.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) seen.add(trimmed);
    }
  }
  return seen.size === 0 ? undefined : [...seen].join(',');
}

function renderTable(trades: readonly TradeResource[]): void {
  const table = createTable(['Trade', 'Market', 'Side', 'Out#', 'Amount', 'Status', 'Tx']);
  for (const t of trades) {
    table.push([
      shortId(t.id),
      shortId(t.marketId),
      t.side,
      String(t.outcomeIndex),
      formatUsdcDecimal(t.amount),
      colorStatus(t.status),
      t.txHash ? shortId(t.txHash, 10) : '-',
    ]);
  }
  print(table.toString());
}
