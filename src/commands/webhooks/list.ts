/**
 * `kash webhooks list` — paginated listing of webhook delivery events
 * for the authenticating key.
 *
 * Wraps `GET /v1/webhooks/events` (DX6). The same shape that surfaces
 * inline on a trade resource's `webhookDelivery` field is now also
 * accessible as a flat feed — useful for auditing what shipped and
 * triaging delivery failures without N trade lookups.
 *
 * Filter shape mirrors the SDK: `--status` accepts a comma-separated
 * list of derived statuses or can be repeated. Both forms collapse to
 * the same comma-string the server expects.
 *
 * Flag conventions mirror `kash markets list` and `kash trade list`:
 * `-l/-c/-a` short forms for `--limit/--cursor/--all`, default page
 * size 20, `--ndjson` streaming for AI-agent consumption.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style, writeNdjson } from '../../utils/output.js';

import type { WebhookEventResource } from '@kashdao/sdk';

const STATUS_VALUES = ['none', 'pending', 'delivered', 'retrying', 'failed'] as const;
type StatusValue = (typeof STATUS_VALUES)[number];

type ListOptions = {
  readonly limit?: string;
  readonly cursor?: string;
  readonly status?: readonly StatusValue[];
  readonly all?: boolean;
  readonly ndjson?: boolean;
};

export const listWebhookEventsCommand = new Command('list')
  .description('List recent webhook delivery events for the calling key.')
  .option('-l, --limit <n>', 'page size (1-100)', '20')
  .option('-c, --cursor <cursor>', 'opaque cursor from a previous response')
  .option('-a, --all', 'walk every page (subject to --limit per page)', false)
  .option(
    '--ndjson',
    'stream results as newline-delimited JSON (one record per line); implies --all'
  )
  // Note: we deliberately do NOT use Commander's `.choices()` here.
  // Commander validates each variadic entry against the choices list
  // BEFORE our normaliser runs, so `--status failed,retrying` (a
  // single comma-string entry) gets rejected as not matching any
  // choice. The normaliser below splits commas first and then
  // validates, so both shapes (`--status failed,retrying` and
  // `--status failed --status retrying`) work.
  .option(
    '--status <status...>',
    `filter by derived status (one of: ${STATUS_VALUES.join(', ')}); repeat or comma-separate`
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash webhooks list
  $ kash webhooks list --status failed --status retrying
  $ kash webhooks list --status failed,retrying -l 100
  $ kash webhooks list --all --json | jq '.[] | select(.status == "failed")'
  $ kash webhooks list --ndjson | while read -r line; do echo "$line" | jq -r .id; done
`
  )
  .action(async (opts: ListOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    const limit = opts.limit === undefined ? 20 : parsePositiveInt(opts.limit, 'limit');
    if (limit < 1 || limit > 100) {
      throw new CliValidationError('--limit must be between 1 and 100.', undefined, 'limit');
    }

    // `--status failed,retrying` (single comma-string) and
    // `--status failed --status retrying` (repeated) both reach us
    // as an array; flatten + split + dedupe so the SDK call is uniform.
    const status = normaliseStatus(opts.status);

    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      const page = await client.webhooks.list({
        limit,
        ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
        ...(status === undefined ? {} : { status }),
      });

      if (opts.ndjson === true) {
        // Stream every record as one line of NDJSON to stdout. Avoids
        // buffering the full result set — the agent reads as we go.
        for await (const event of page) {
          writeNdjson(event);
        }
        return;
      }

      if (opts.all === true) {
        const collected: WebhookEventResource[] = [];
        for await (const event of page) collected.push(event);
        if (globals.json) {
          // Canonical `{data, pagination, count}` — see markets/list.ts
          // for rationale. Same shape across single-page and walked
          // modes lets agents pin to one schema.
          printJson({
            data: collected,
            pagination: { hasMore: false, cursor: null },
            count: collected.length,
          });
          return;
        }
        renderRows(collected);
        return;
      }

      // Default: first page only.
      if (globals.json) {
        printJson({
          data: page.data,
          pagination: page.pagination,
          count: page.data.length,
        });
        return;
      }
      renderRows(page.data);
      if (page.pagination.hasMore && page.pagination.cursor) {
        log.detail('Next page', `--cursor ${page.pagination.cursor}`);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

function renderRows(rows: readonly WebhookEventResource[]): void {
  if (rows.length === 0) {
    print(style.dim('  (no webhook events)'));
    return;
  }
  print('');
  for (const row of rows) {
    const statusBadge = renderStatus(row.status);
    const tradeCol = row.tradeRequestId ? row.tradeRequestId.slice(0, 8) : style.dim('—');
    print(
      `  ${statusBadge} ${style.dim(row.id.slice(0, 8))} ` +
        `${row.eventType.padEnd(28)} trade=${tradeCol} ` +
        `attempts=${String(row.delivery.attempts).padStart(2)} ` +
        `${style.dim(row.emittedAt)}`
    );
  }
  print('');
}

function normaliseStatus(raw: ListOptions['status']): readonly StatusValue[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  // Each element may itself be comma-separated. Flatten, dedupe, and
  // validate. We throw on unknown statuses (instead of silently
  // dropping them) so a typo like `--status faild` surfaces as
  // INVALID_INPUT rather than a confusing empty result set.
  const seen = new Set<StatusValue>();
  for (const entry of raw) {
    for (const piece of entry.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) continue;
      if (!(STATUS_VALUES as readonly string[]).includes(trimmed)) {
        throw new CliValidationError(
          `Unknown --status "${trimmed}".`,
          `Allowed: ${STATUS_VALUES.join(', ')}.`,
          'status'
        );
      }
      seen.add(trimmed as StatusValue);
    }
  }
  return seen.size === 0 ? undefined : [...seen];
}

function renderStatus(status: WebhookEventResource['status']): string {
  switch (status) {
    case 'delivered':
      return style.success('✓ delivered');
    case 'failed':
      return style.error('✗ failed   ');
    case 'retrying':
      return style.warn('⟳ retrying ');
    case 'pending':
      return style.dim('… pending  ');
    case 'none':
      return style.dim('· none     ');
    default: {
      // Exhaustiveness guard — if a new status is added to the
      // union, TS surfaces the missing case here at compile time
      // rather than the function silently returning `undefined`.
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
