/**
 * `kash protocol fees` — EIP-1559 fee estimation for the configured
 * chain. Wraps `client.bundler.estimateFees(options)` from the
 * protocol-sdk.
 *
 * Useful for direct-mode operators tuning their submit strategy:
 * compare what the SDK would suggest under different multipliers,
 * sample sizes, or percentile windows. The estimate is read-only and
 * uses `eth_feeHistory` against the configured RPC.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatGwei } from '../../utils/formatting.js';
import {
  parseOptionalPositiveFloat,
  parseOptionalPositiveInt,
  readGlobals,
} from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';

type FeesOptions = {
  blocks?: string;
  percentile?: string;
  baseMultiplier?: string;
  priorityFloorGwei?: string;
};

export const feesCommand = new Command('fees')
  .description('EIP-1559 fee estimate for the configured chain (uses eth_feeHistory).')
  .option('--blocks <n>', 'number of recent blocks to sample (default 4)')
  .option(
    '--percentile <n>',
    'priority-fee percentile to take from each sampled block (1-99, default 50)'
  )
  .option(
    '--base-multiplier <n>',
    'multiplier applied to predicted next-block base fee (default 2.0; raise for congested chains)'
  )
  .option('--priority-floor-gwei <n>', 'floor for maxPriorityFeePerGas in gwei (default 1)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol fees
  $ kash protocol fees --base-multiplier 3 --json --quiet | jq -r '.maxFeePerGas'
  $ kash protocol fees --blocks 16 --percentile 75   # smoother, more conservative
`
  )
  .action(async (options: FeesOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    const blocks = parseOptionalPositiveInt(options.blocks, 'blocks');
    const percentile = parseOptionalPositiveInt(options.percentile, 'percentile');
    if (percentile !== undefined && (percentile < 1 || percentile > 99)) {
      throw new CliValidationError(
        '--percentile must be between 1 and 99.',
        undefined,
        'percentile'
      );
    }
    const baseMultiplier = parseOptionalPositiveFloat(options.baseMultiplier, 'base-multiplier');
    const priorityFloorGwei = parseOptionalPositiveInt(
      options.priorityFloorGwei,
      'priority-floor-gwei'
    );

    try {
      const resolved = await buildDirectClient({ globals });
      const estimate = await resolved.client.bundler.estimateFees({
        ...(blocks === undefined ? {} : { blockCount: blocks }),
        ...(percentile === undefined ? {} : { rewardPercentile: percentile }),
        ...(baseMultiplier === undefined ? {} : { baseMultiplier }),
        ...(priorityFloorGwei === undefined
          ? {}
          : { priorityFeeFloorWei: BigInt(priorityFloorGwei) * 10n ** 9n }),
      });

      const payload = {
        chainId: resolved.chainId,
        maxFeePerGas: estimate.maxFeePerGas.toString(),
        maxPriorityFeePerGas: estimate.maxPriorityFeePerGas.toString(),
      };

      if (globals.json) {
        printJson(payload);
        return;
      }

      print('');
      print(`  ${style.dim('Chain    ')} ${String(resolved.chainId)}`);
      print(
        `  ${style.dim('maxFee   ')} ${formatGwei(estimate.maxFeePerGas)} gwei ${style.dim(`(${estimate.maxFeePerGas.toString()} wei)`)}`
      );
      print(
        `  ${style.dim('maxPrio  ')} ${formatGwei(estimate.maxPriorityFeePerGas)} gwei ${style.dim(`(${estimate.maxPriorityFeePerGas.toString()} wei)`)}`
      );
    } catch (cause) {
      throw toCliError(cause);
    }
  });

// `formatGwei` lives in `utils/formatting.ts` — single source of
// truth for the wei-to-gwei display format shared with `kash eoa fees`
// and the balance commands.
