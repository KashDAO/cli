/**
 * `kash trade status <id>` — fetch a single trade. With `--poll`, block
 * until the trade reaches a terminal state (uses the SDK's polling
 * helper).
 */

import { Command } from 'commander';
import ora from 'ora';

import { toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { colorStatus, formatDate, formatUsdcDecimal, shortId } from '../../utils/formatting.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { isQuiet, log, print, printJson, style } from '../../utils/output.js';

import type { TradeResource } from '@kashdao/sdk';

type StatusOptions = {
  poll?: boolean;
  timeout?: string;
  pollInterval?: string;
};

export const statusCommand = new Command('status')
  .description('Show the status of a trade. Use --poll to block until terminal.')
  .argument('<id>', 'trade UUID')
  .addHelpText(
    'after',
    `
Examples:
  $ kash trade status 9f0b...
  $ kash trade status 9f0b... --poll
  $ kash trade status 9f0b... --poll --json --quiet | jq -r '.txHash'
`
  )
  .option('--poll', 'poll until the trade reaches a terminal state')
  .option(
    '--wait-timeout-ms, --timeout <ms>',
    'poll timeout in milliseconds (default 60000) — distinct from the global --timeout-ms (per-HTTP-request)'
  )
  .option(
    '--poll-interval-ms, --poll-interval <ms>',
    'poll interval in milliseconds (default 2000)'
  )
  .action(async (id: string, options: StatusOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    let trade: TradeResource;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      if (options.poll) {
        const timeoutMs = options.timeout ? parsePositiveInt(options.timeout, 'timeout') : 60_000;
        const pollIntervalMs = options.pollInterval
          ? parsePositiveInt(options.pollInterval, 'poll-interval')
          : 2_000;

        // Wire SIGINT/SIGTERM to abort the in-flight poll cleanly.
        // Without this, Ctrl-C during a 60s wait leaves the SDK
        // mid-fetch — the polling loop's own signal-handler tears
        // down the process, but any in-flight HTTP request stays
        // unaborted. Pattern mirrors `kash protocol watch`.
        const ac = new AbortController();
        const onSig = (): void => ac.abort();
        process.on('SIGINT', onSig);
        process.on('SIGTERM', onSig);
        try {
          if (globals.json || isQuiet()) {
            trade = await client.trades.waitForCompletion(id, {
              timeoutMs,
              pollIntervalMs,
              signal: ac.signal,
            });
          } else {
            const spinner = ora({
              text: `Polling trade ${shortId(id)}…`,
              stream: process.stderr,
            }).start();
            try {
              trade = await client.trades.waitForCompletion(id, {
                timeoutMs,
                pollIntervalMs,
                signal: ac.signal,
                onStatus: (current) => {
                  spinner.text = `Trade ${shortId(current.id)} — status: ${current.status}`;
                },
              });
              if (trade.status === 'completed') {
                spinner.succeed(`Trade ${shortId(trade.id)} completed.`);
              } else {
                spinner.fail(`Trade ${shortId(trade.id)} ${trade.status}.`);
              }
            } catch (cause) {
              spinner.fail('Polling stopped.');
              throw cause;
            }
          }
        } finally {
          process.off('SIGINT', onSig);
          process.off('SIGTERM', onSig);
        }
      } else {
        trade = await client.trades.get(id);
      }
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(trade);
      return;
    }

    print('');
    print(`  ${style.dim('Trade id    ')} ${trade.id}`);
    print(`  ${style.dim('Market id   ')} ${trade.marketId}`);
    print(`  ${style.dim('Side        ')} ${trade.side}`);
    print(`  ${style.dim('Outcome idx ')} ${String(trade.outcomeIndex)}`);
    print(`  ${style.dim('Amount      ')} ${formatUsdcDecimal(trade.amount)}`);
    print(`  ${style.dim('Status      ')} ${colorStatus(trade.status)}`);
    // Use explicit null checks rather than truthy checks — empty
    // strings are valid SDK values that we'd otherwise silently hide.
    if (trade.txHash !== null) {
      print(`  ${style.dim('Tx hash     ')} ${trade.txHash}`);
    }
    if (trade.tokensOut !== null) {
      print(`  ${style.dim('Tokens out  ')} ${trade.tokensOut}`);
    }
    if (trade.errorCode !== null || trade.errorMessage !== null) {
      print(
        `  ${style.dim('Error       ')} [${trade.errorCode ?? 'UNKNOWN'}] ${trade.errorMessage ?? ''}`
      );
      // Cross-link to the correlation timeline so an operator
      // diagnosing a failure can see every event the API and the
      // execution engine emitted for this trade.
      log.info(`Inspect the full timeline: kash trace ${trade.correlationId}`);
    }
    print(`  ${style.dim('Created     ')} ${formatDate(trade.createdAt)}`);
    print(`  ${style.dim('Updated     ')} ${formatDate(trade.updatedAt)}`);
    if (trade.webhookDelivery !== null) {
      // Surface webhook delivery state when present — agents and
      // humans both need this to debug "did the integration receive
      // the event?" without dropping into JSON mode.
      const wh = trade.webhookDelivery;
      const failure = wh.lastFailureCode === null ? '' : ` (${wh.lastFailureCode})`;
      const httpStatus = wh.lastStatusCode === null ? '' : ` HTTP ${String(wh.lastStatusCode)}`;
      print(
        `  ${style.dim('Webhook     ')} ${colorStatus(wh.status)} attempts=${String(wh.attempts)}${httpStatus}${failure}`
      );
      if (wh.lastAttemptedAt !== null) {
        print(`  ${style.dim('  Last try  ')} ${formatDate(wh.lastAttemptedAt)}`);
      }
    }
    if (trade.status === 'pending_confirmation') {
      log.warn('Trade is awaiting high-value confirmation. Run `kash trade confirm <id> <token>`.');
    }
  });
