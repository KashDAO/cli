/**
 * `kash trade buy <marketId>` — purchase outcome tokens.
 */

import { Command } from 'commander';

import { readGlobals } from '../../utils/global-options.js';

import { placeTrade, type PlaceTradeOptions } from './place.js';

export const buyCommand = new Command('buy')
  .description('Buy outcome tokens for a market.')
  .argument('<marketId>', 'market UUID')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-a, --amount <usdc>', 'USDC amount as a decimal (max 6 fractional digits)')
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
  $ kash trade buy 9f0b... --outcome 0 --amount 10
  $ kash trade buy 9f0b... --outcome 1 --amount 25 --wait
  $ kash trade buy 9f0b... --outcome 0 --amount 5 --auto-idempotency-key --json --quiet
  $ kash trade buy 9f0b... --outcome 0 --amount 10 --dry-run --json
`
  )
  .action(async (marketId: string, options: PlaceTradeOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    await placeTrade({ marketId, side: 'buy', options, globals });
  });
