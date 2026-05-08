/**
 * `kash protocol watch <market>` — long-running subscription to
 * on-chain trade events for a market.
 *
 * Streams every `TRADE`, `RESOLVED`, and `FROZEN` event the SDK
 * decodes, one NDJSON record per line on stdout. Designed for piping
 * into `jq`, `awk`, or downstream collectors. SIGINT / Ctrl-C
 * terminates cleanly via `subscription.unsubscribe()`.
 *
 * **Best-effort delivery.** viem's `watchContractEvent` reconnects on
 * RPC drops but does NOT replay missed events. For gap-free coverage,
 * pair with `kash markets predictions` (the public-API trade feed)
 * which IS gap-free since it sources from our indexer.
 *
 * **Termination:**
 *   - `--max-events <n>` exits cleanly after N events.
 *   - `--timeout-ms <ms>` exits after a wall-clock budget.
 *   - SIGINT / Ctrl-C unsubscribes and exits 0.
 *
 * **Output:**
 *   - JSON mode (`--json`) emits NDJSON: each event = one line.
 *   - Human mode prints a compact `[timestamp] TYPE side outcome amounts...` line.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, style, writeNdjson } from '../../utils/output.js';
import { validateAddress } from '../../utils/trade-input.js';

type WatchOptions = {
  maxEvents?: string;
  timeoutMs?: string;
};

export const watchCommand = new Command('watch')
  .description('Subscribe to on-chain trade events for a market (NDJSON stream).')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .option('--max-events <n>', 'exit cleanly after observing N events')
  .option('--timeout-ms <n>', 'exit cleanly after this wall-clock budget (ms)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol watch 0xMarket... --json
  $ kash protocol watch 0xMarket... --json --quiet | jq -r '.transactionHash'
  $ kash protocol watch 0xMarket... --max-events 100 --json

Notes:
  - Best-effort: on RPC reconnect, missed events are NOT replayed. For
    gap-free history, use \`kash markets predictions <id>\` (indexer-backed).
  - Press Ctrl-C to terminate cleanly. The subscription unsubscribes
    before the process exits.
`
  )
  .action(async (market: string, options: WatchOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    const marketAddress = validateAddress(market, 'market');

    const maxEvents = options.maxEvents
      ? parsePositiveInt(options.maxEvents, 'max-events')
      : undefined;
    const timeoutMs = options.timeoutMs
      ? parsePositiveInt(options.timeoutMs, 'timeout-ms')
      : undefined;

    try {
      const resolved = await buildDirectClient({ globals });

      // **Lifecycle.** `markets.watch` returns a `subscription` that
      // holds an open RPC connection. We need to keep the process
      // alive until one of three signals fires (SIGINT / max-events /
      // timeout-ms), then tear down cleanly. We model the wait as a
      // Deferred so the await is reachable / collectable instead of
      // a never-resolving promise that leaks on any future post-
      // processing wrap.
      let resolveDone: ((reason: string) => void) | undefined;
      let count = 0;
      const done = new Promise<string>((resolve) => {
        resolveDone = resolve;
      });

      // Holder pattern so `teardown` (defined now) can reference the
      // subscription that `markets.watch` returns shortly. Today the
      // SDK's watch is async-only, but if a future implementation
      // synchronously fired `onEvent` during subscribe (or threw
      // before returning), referencing the binding directly would
      // throw. The `subscriptionHolder.current` indirection keeps the
      // closure stable and lets ESLint's `prefer-const` pass.
      const subscriptionHolder: {
        current: ReturnType<typeof resolved.client.markets.watch> | undefined;
      } = { current: undefined };
      let teardownTriggered = false;
      const teardown = (reason: string): void => {
        if (teardownTriggered) return;
        teardownTriggered = true;
        try {
          subscriptionHolder.current?.unsubscribe();
        } catch {
          // ignore — best-effort cleanup
        }
        resolveDone?.(reason);
      };

      subscriptionHolder.current = resolved.client.markets.watch(marketAddress, {
        onEvent: (event) => {
          if (globals.json) {
            // `writeNdjson`'s jsonReplacer is the single source of
            // truth for bigint→decimal-string encoding (incl. inside
            // arrays — `JSON.stringify` walks recursively). No
            // pre-conversion needed here.
            writeNdjson(event);
          } else {
            print(formatEventHuman(event));
          }
          count += 1;
          if (maxEvents !== undefined && count >= maxEvents) {
            teardown(`reached --max-events ${String(maxEvents)}`);
          }
        },
        onReconnect: () => {
          if (!globals.json) {
            log.warn('Watcher reconnecting — missed events will NOT be replayed.');
          }
        },
        onError: (err) => {
          // Non-fatal — viem will retry. Surface it on stderr in human mode.
          if (!globals.json) {
            log.warn(`Watcher error: ${err.message}`);
          }
        },
      });

      // SIGINT / SIGTERM tear down rather than process.exit so any
      // post-processing (rare today, but the seam matters) can run.
      const onSigint = (): void => teardown('SIGINT');
      const onSigterm = (): void => teardown('SIGTERM');
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);

      // Wall-clock budget. `.unref()` so a quick exit (max-events
      // before the timer fires) doesn't keep the event loop alive.
      const timeoutHandle =
        timeoutMs !== undefined
          ? setTimeout(() => teardown(`reached --timeout-ms ${String(timeoutMs)}`), timeoutMs)
          : undefined;
      timeoutHandle?.unref();

      // Print a human-mode header so the user sees something while
      // waiting for the first event. JSON mode stays silent on stderr
      // so the pipe is pure NDJSON.
      if (!globals.json) {
        log.info(`Watching market ${marketAddress}…`);
        log.detail('Stop', 'Ctrl-C');
        if (maxEvents !== undefined) log.detail('Max events', String(maxEvents));
        if (timeoutMs !== undefined) log.detail('Timeout (ms)', String(timeoutMs));
      }

      const reason = await done;
      // Clean up signal handlers + timer so a wrapping caller doesn't
      // leak them.
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

      if (!globals.json) {
        log.info(`Watcher stopped (${reason}).`);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

// ---------------------------------------------------------------------------
// Event serialization
// ---------------------------------------------------------------------------

export type WatchEventLike =
  | {
      type: 'TRADE';
      side: 'buy' | 'sell';
      outcome: number;
      receiver: `0x${string}`;
      assetsUsdc: bigint;
      tokensWad: bigint;
      reserveAfterWad: bigint;
      supplyAfterWad: readonly bigint[];
      blockNumber: bigint;
      transactionHash: `0x${string}`;
      logIndex: number;
    }
  | {
      type: 'RESOLVED';
      winningOutcome: number;
      evidenceHash: `0x${string}`;
      blockNumber: bigint;
      transactionHash: `0x${string}`;
      logIndex: number;
    }
  | {
      type: 'FROZEN';
      observedAt: bigint;
      blockNumber: bigint;
      transactionHash: `0x${string}`;
      logIndex: number;
    };

export function formatEventHuman(event: WatchEventLike): string {
  const time = new Date().toISOString().slice(11, 19); // HH:MM:SS
  if (event.type === 'TRADE') {
    return `${style.dim(time)}  ${style.bold('TRADE')}    side=${event.side} out=${String(event.outcome)} usdc=${event.assetsUsdc.toString()} tokens=${event.tokensWad.toString()} tx=${event.transactionHash.slice(0, 10)}…`;
  }
  if (event.type === 'RESOLVED') {
    return `${style.dim(time)}  ${style.bold('RESOLVED')} winner=${String(event.winningOutcome)} tx=${event.transactionHash.slice(0, 10)}…`;
  }
  return `${style.dim(time)}  ${style.bold('FROZEN')}   observedAt=${event.observedAt.toString()} tx=${event.transactionHash.slice(0, 10)}…`;
}
