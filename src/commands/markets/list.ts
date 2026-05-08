/**
 * `kash markets list` — page through markets.
 *
 * Default human output is a table of the first page. `--all` walks
 * the SDK's auto-paginator and prints every market — useful for
 * exporting to JSON. Status is uppercased before sending so users
 * don't have to remember the canonical casing.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import {
  colorStatus,
  createTable,
  formatProbability,
  shortId,
  truncate,
} from '../../utils/formatting.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, writeNdjson } from '../../utils/output.js';

import type { MarketResource, MarketStatus } from '@kashdao/sdk';

type ListOptions = {
  status?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  ndjson?: boolean;
};

const ALLOWED_STATUSES: ReadonlySet<MarketStatus> = new Set(['UNSEEDED', 'ACTIVE', 'RESOLVED']);

export const listMarketsCommand = new Command('list')
  .description('List markets.')
  .option('-s, --status <status>', 'filter by status (UNSEEDED | ACTIVE | RESOLVED)')
  .option('-l, --limit <n>', 'page size (1-100)', '20')
  .option('-c, --cursor <cursor>', 'pagination cursor returned by a previous call')
  .option('-a, --all', 'walk every page (use with --json for export)')
  .option(
    '--ndjson',
    'stream results as newline-delimited JSON (one record per line); implies --all'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash markets list --status ACTIVE
  $ kash markets list --json --quiet | jq '.data[].id'
  $ kash markets list --ndjson | while read -r line; do echo "$line" | jq -r .id; done
  $ kash markets list --all --json --quiet > markets.json

Notes:
  --ndjson emits one JSON record per line. Consumers must read
  line-by-line (\`while read -r\`, \`jq -c\`, \`split('\n')\`) — DO NOT
  buffer-then-parse, as the stream may run for arbitrarily many pages.
`
  )
  .action(async (options: ListOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    const limit = options.limit === undefined ? 20 : parsePositiveInt(options.limit, 'limit');
    if (limit < 1 || limit > 100) {
      throw new CliValidationError('--limit must be between 1 and 100.', undefined, 'limit');
    }

    const status = options.status ? normaliseStatus(options.status) : undefined;

    let response;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      response = await client.markets.list({
        limit,
        ...(status === undefined ? {} : { status }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });

      if (options.ndjson) {
        // Stream every record as one line of NDJSON to stdout. Avoids
        // buffering the full result set — the agent reads as we go.
        for await (const market of response) {
          writeNdjson(market);
        }
        return;
      }

      if (options.all) {
        const collected: MarketResource[] = [];
        for await (const market of response) collected.push(market);
        if (globals.json) {
          // Canonical list-envelope shape: `{data, pagination, count}`.
          // After walking every page, `pagination.hasMore` is false
          // and `cursor` is null — same fields, terminal values.
          // Agents pin to this single shape across both modes.
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
      log.info('No markets matched the filter.');
      return;
    }
    renderTable(response.data);

    if (response.pagination.hasMore && response.pagination.cursor) {
      log.detail('Next page', `--cursor ${response.pagination.cursor}`);
    }
  });

function renderTable(markets: readonly MarketResource[]): void {
  const table = createTable(['ID', 'Title', 'Status', 'Outcomes', 'Top outcome', 'Created']);
  for (const market of markets) {
    const outcomes = market.outcomes;
    const top = outcomes.reduce<(typeof outcomes)[number] | undefined>((acc, current) => {
      if (acc === undefined) return current;
      return current.probability > acc.probability ? current : acc;
    }, undefined);
    table.push([
      shortId(market.id),
      truncate(market.title ?? '(untitled)', 42),
      colorStatus(market.status ?? 'UNKNOWN'),
      String(market.outcomeCount),
      top ? `${truncate(top.label, 18)} (${formatProbability(top.probability)})` : '-',
      market.createdAt.slice(0, 10),
    ]);
  }
  print(table.toString());
}

function normaliseStatus(value: string): MarketStatus {
  const upper = value.toUpperCase() as MarketStatus;
  if (!ALLOWED_STATUSES.has(upper)) {
    throw new CliValidationError(
      `Unknown market status "${value}".`,
      'Allowed: UNSEEDED, ACTIVE, RESOLVED.'
    );
  }
  return upper;
}
