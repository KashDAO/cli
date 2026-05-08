/**
 * `kash markets predictions <market-id>` — paginated feed of recent
 * trades against a single market. Wraps `kash.markets.predictions`.
 *
 * Requires API key with `markets:read` scope (granted by default on every
 * tier). Pagination shape mirrors `kash markets list` and `kash trade list`:
 * default first-page render, `--all` to walk every page, `--ndjson`
 * to stream NDJSON one-record-per-line for agents.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { createTable, formatDate, shortId } from '../../utils/formatting.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, writeNdjson } from '../../utils/output.js';
import { parseOutcomeIndex } from '../../utils/trade-input.js';

import type { PredictionResource } from '@kashdao/sdk';

type PredictionsOptions = {
  side?: string;
  outcome?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  ndjson?: boolean;
};

export const predictionsCommand = new Command('predictions')
  .description('Recent trades against a market (cursor-paginated, newest first).')
  .argument('<marketId>', 'market UUID')
  .option('-s, --side <side>', 'filter to a single side: buy | sell')
  .option('-o, --outcome <index>', 'filter to a single outcome index (0-based)')
  .option('-l, --limit <n>', 'page size (1-100)', '50')
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
  $ kash markets predictions 9f0b...
  $ kash markets predictions 9f0b... --side buy --outcome 0
  $ kash markets predictions 9f0b... --json --quiet | jq -r '.data[].transactionHash'
  $ kash markets predictions 9f0b... --ndjson | head -100
  $ kash markets predictions 9f0b... --all --json --quiet > history.json
`
  )
  .action(async (marketId: string, options: PredictionsOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    const limit = options.limit === undefined ? 50 : parsePositiveInt(options.limit, 'limit');
    if (limit < 1 || limit > 100) {
      throw new CliValidationError('--limit must be between 1 and 100.', undefined, 'limit');
    }

    const side = options.side ? validateSide(options.side) : undefined;
    const outcomeIndex = options.outcome ? parseOutcomeIndex(options.outcome) : undefined;

    let response;
    try {
      // Requires API key with `markets:read` scope (granted by default
      // on every tier). Fail fast at build time if no key is configured
      // rather than waiting for the server's 401.
      const { client } = await buildClient({ requireAuth: true, globals });
      response = await client.markets.predictions(marketId, {
        limit,
        ...(side === undefined ? {} : { side }),
        ...(outcomeIndex === undefined ? {} : { outcomeIndex }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });

      if (options.ndjson) {
        for await (const prediction of response) {
          writeNdjson(prediction);
        }
        return;
      }

      if (options.all) {
        const collected: PredictionResource[] = [];
        for await (const prediction of response) collected.push(prediction);
        if (globals.json) {
          // Canonical `{data, pagination, count}` envelope — matches
          // every other list-shaped command (`markets list`,
          // `trade list`, `webhooks list`). After walking every
          // page, `pagination.hasMore` is false and `cursor` is null.
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
      log.info('No predictions matched the filter.');
      return;
    }
    renderTable(response.data);

    if (response.pagination.hasMore && response.pagination.cursor) {
      log.detail('Next page', `--cursor ${response.pagination.cursor}`);
    }
  });

function renderTable(predictions: readonly PredictionResource[]): void {
  const table = createTable(['Time', 'Side', 'Out#', 'Amount', 'Price', 'Tx']);
  for (const p of predictions) {
    const amount = p.side === 'buy' ? (p.usdcIn ?? '-') : (p.tokensIn ?? '-');
    table.push([
      formatDate(p.timestamp),
      p.side,
      String(p.outcomeIndex),
      amount,
      p.price,
      shortId(p.transactionHash),
    ]);
  }
  print(table.toString());
}

function validateSide(value: string): 'buy' | 'sell' {
  const lower = value.toLowerCase();
  if (lower !== 'buy' && lower !== 'sell') {
    throw new CliValidationError(`Unknown --side "${value}".`, 'Allowed: buy, sell.', 'side');
  }
  return lower;
}
