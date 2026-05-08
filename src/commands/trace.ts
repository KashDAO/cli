/**
 * `kash trace <correlationId>` — fetch the curated event timeline for
 * a single trade's correlation id.
 *
 * The correlation id is the identifier that ties together every event
 * a trade emits across the pipeline (intent parsing → funding →
 * bridge → execution → webhook delivery). Wraps the SDK's
 * `kash.traces.get(...)`. The server returns a sanitized timeline —
 * no raw event_data leaks — so this command is safe to share output
 * from.
 *
 * **Common workflow.** Get a trade's correlation id from
 * `kash trade status <id> --json | jq -r '.correlationId'`, then pass
 * it in here.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../errors.js';
import { buildClient } from '../utils/client.js';
import { formatDate } from '../utils/formatting.js';
import { readGlobals } from '../utils/global-options.js';
import { print, printJson, style } from '../utils/output.js';

import type { TraceEvent, TraceResource } from '@kashdao/sdk';

/** UUID v4-ish — the same shape the API enforces server-side. */
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const traceCommand = new Command('trace')
  .description("Fetch the curated event timeline for a trade's correlation id.")
  .argument(
    '<correlationId>',
    'correlation UUID — see `kash trade status <id> --json | jq -r .correlationId`'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash trace 33333333-3333-3333-3333-333333333333
  $ kash trace 33333333-... --json --quiet | jq '.events[] | {type, occurredAt}'

Notes:
  - Trace returns 404 (CONFLICT-style) if the correlation id is unknown OR your
    API key does not own the trade behind it. This is by design — it prevents
    enumeration of other users' correlation ids.
  - Output is curated: raw event_data is NOT returned. Only allowlisted fields
    (txHash, tokensOut, errorCode, etc.) appear.
`
  )
  .action(async (correlationId: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);

    if (!UUID_REGEX.test(correlationId)) {
      throw new CliValidationError(
        '<correlationId> must be a UUID.',
        'Get one from `kash trade status <id> --json | jq -r .correlationId`.',
        'correlationId'
      );
    }

    let trace: TraceResource;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      trace = await client.traces.get(correlationId);
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(trace);
      return;
    }
    renderHuman(trace);
  });

/**
 * Human-mode timeline. Each event is one line:
 *   `[timestamp] event.type    summary`
 * with summary derived from the curated `data` fields.
 */
function renderHuman(trace: TraceResource): void {
  print('');
  print(`  ${style.dim('Correlation ')} ${trace.correlationId}`);
  print(`  ${style.dim('Events      ')} ${String(trace.events.length)}`);
  print('');
  if (trace.events.length === 0) {
    print(style.dim('  (no events emitted yet — has the trade started?)'));
    return;
  }
  for (const event of trace.events) {
    print(
      `  ${style.dim(formatDate(event.occurredAt))}  ${formatType(event.type)}  ${formatSummary(event)}`
    );
  }
}

/**
 * Strip the `com.kash.` prefix and `.v1` suffix so the type column
 * stays readable: `com.kash.trade.executed.v1` → `trade.executed`.
 */
function formatType(type: string): string {
  return style.bold(type.replace(/^com\.kash\./, '').replace(/\.v\d+$/, ''));
}

/**
 * One-line summary of the curated `data` bag. Picks the fields that
 * matter per event flavour without printing the full record.
 */
function formatSummary(event: TraceEvent): string {
  const d = event.data;
  const parts: string[] = [];
  if (d.tradeId) parts.push(`trade=${d.tradeId.slice(0, 8)}`);
  if (d.side) parts.push(`side=${d.side}`);
  if (d.outcomeIndex !== undefined) parts.push(`outcome=${String(d.outcomeIndex)}`);
  if (d.amount) parts.push(`amount=${d.amount}`);
  if (d.txHash) parts.push(`tx=${d.txHash.slice(0, 10)}…`);
  if (d.tokensOut) parts.push(`tokensOut=${d.tokensOut}`);
  if (d.errorCode) parts.push(style.error(`error=${d.errorCode}`));
  if (d.errorMessage) parts.push(style.error(`"${d.errorMessage}"`));
  if (d.reason) parts.push(`reason="${d.reason}"`);
  if (d.chainId !== undefined) parts.push(`chain=${String(d.chainId)}`);
  return parts.length === 0 ? style.dim('(no curated fields)') : parts.join(' ');
}
