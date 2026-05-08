/**
 * `kash account usage` — per-key telemetry summary.
 *
 * Wraps `GET /v1/account/usage` (DX7). Returns rolling-window stats
 * for the calling key: trade volume + success rate (24h / 7d / 30d),
 * end-to-end latency p50/p99, webhook delivery success, and recent
 * auth + rate-limit signals.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';

import type { AccountUsage } from '@kashdao/sdk';

export const usageCommand = new Command('usage')
  .description('Show per-key telemetry summary (24h / 7d / 30d windows).')
  .addHelpText(
    'after',
    `
Examples:
  $ kash account usage
  $ kash account usage --json | jq '.trades["24h"].successRate'
  $ kash account usage --json --quiet | jq -r '.trades["7d"].successRate * 100'
`
  )
  .action(async (_opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    let usage: AccountUsage;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      usage = await client.account.usage();
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(usage);
      return;
    }

    print('');
    print(`  ${style.dim('API key       ')} ${usage.apiKeyId}`);
    print(`  ${style.dim('Generated at  ')} ${usage.generatedAt}`);

    print('');
    print(`  ${style.dim('Trades')}`);
    renderTradeWindow('  24h', usage.trades['24h']);
    print(
      `        latency p50 ${formatMs(usage.trades['24h'].latencyMs.p50)}  ` +
        `p99 ${formatMs(usage.trades['24h'].latencyMs.p99)}`
    );
    renderTradeWindow('   7d', usage.trades['7d']);
    renderTradeWindow('  30d', usage.trades['30d']);

    print('');
    print(`  ${style.dim('Webhooks (7d)')}`);
    const wh = usage.webhooks['7d'];
    print(
      `        emitted=${wh.emitted}  delivered=${wh.delivered}  failed=${wh.failed}  ` +
        `success=${formatRate(wh.successRate)}`
    );

    print('');
    print(`  ${style.dim('Auth (24h)')}`);
    print(
      `        failures=${usage.auth['24h'].failures}  ` +
        `rate-limit-rejections=${usage.auth['24h'].rateLimitRejections}`
    );
    print('');
  });

function renderTradeWindow(
  label: string,
  w: AccountUsage['trades']['24h'] | AccountUsage['trades']['7d']
): void {
  print(
    `    ${label}  total=${w.total}  completed=${w.completed}  ` +
      `failed=${w.failed}  success=${formatRate(w.successRate)}`
  );
}

function formatRate(rate: number | null): string {
  if (rate === null) return style.dim('—');
  return `${(rate * 100).toFixed(2)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) return style.dim('—');
  return `${value}ms`;
}
