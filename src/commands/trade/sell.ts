/**
 * `kash trade sell <marketId>` — sell outcome tokens back to the AMM.
 */

import { Command } from 'commander';

import { readGlobals } from '../../utils/global-options.js';

import { placeTrade, type PlaceTradeOptions } from './place.js';

export const sellCommand = new Command('sell')
  .description('Sell outcome tokens back to the market (custodial / hosted-API flow).')
  .argument('<marketId>', 'market UUID')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption(
    '-a, --amount <usdc>',
    'target USDC to receive (decimal, max 6 fractional digits) — NOT tokens-in. ' +
      'Use `kash quote sell --tokens <n>` if you have a tokens-in figure and want a USDC quote first.'
  )
  .option('--wait', 'block until the trade reaches a terminal state')
  .option(
    '--wait-timeout-ms, --timeout <ms>',
    'wait timeout in milliseconds (default 60000) — distinct from the global --timeout-ms (per-HTTP-request)'
  )
  .option(
    '--poll-interval-ms, --poll-interval <ms>',
    'wait poll interval in milliseconds (default 2000)'
  )
  .option('--idempotency-key <key>', 'sets the Idempotency-Key HTTP header')
  .option(
    '--auto-idempotency-key',
    'auto-generate an Idempotency-Key (UUID v4) and surface it in the response'
  )
  .option('--client-request-id <id>', 'sets the body-level clientRequestId for replay safety')
  .option(
    '--dry-run',
    'preview the request without sending — emits the would-be body and resolved headers'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash trade sell 9f0b... --outcome 0 --amount 10        # target $10 USDC out
  $ kash trade sell 9f0b... --outcome 1 --amount 25 --wait
  $ kash trade sell 9f0b... --outcome 0 --amount 5 --auto-idempotency-key --json --quiet
  $ kash trade sell 9f0b... --outcome 0 --amount 10 --dry-run --json

Notes:
  --amount is in USDC for both buy AND sell:
    BUY  — USDC you spend (input).
    SELL — USDC you target receiving (output).
  This is the API contract, not a CLI choice — \`kash quote sell --tokens N\`
  takes a tokens-in figure if that's the shape you have on hand.
`
  )
  .action(async (marketId: string, options: PlaceTradeOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    await placeTrade({ marketId, side: 'sell', options, globals });
  });
