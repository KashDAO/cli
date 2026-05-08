/**
 * `kash quote buy <marketId>` — price quote for buying outcome tokens.
 *
 * Requires API key with `markets:quote` scope (granted by default on every
 * tier; split from `markets:read` because quotes are RPC-heavy). The SDK's
 * `quotes.buy` returns the AMM's `quoteBuyExactAssetsIn` view: how many
 * outcome tokens you get for the given USDC, plus implied probability and
 * effective price.
 *
 * `--amount` is human USDC decimal (e.g. "10" for 10 USDC, "0.50"
 * for 50 cents). The CLI converts to atomic-6 before calling the SDK.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { readGlobals } from '../../utils/global-options.js';
import { printJson } from '../../utils/output.js';
import { parseOutcomeIndex } from '../../utils/trade-input.js';

import { renderQuote, usdcDecimalToAtomic } from './shared.js';

type BuyQuoteOptions = {
  outcome: string;
  amount: string;
};

export const buyQuoteCommand = new Command('buy')
  .description('Quote a buy of USDC into an outcome.')
  .argument('<marketId>', 'market UUID')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-a, --amount <usdc>', 'USDC to spend (decimal, e.g. "10" or "12.50")')
  .addHelpText(
    'after',
    `
Examples:
  $ kash quote buy 9f0b... --outcome 0 --amount 10
  $ kash quote buy 9f0b... --outcome 1 --amount 100 --json --quiet | jq -r '.tokensOut'
`
  )
  .action(async (marketId: string, options: BuyQuoteOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const outcomeIndex = parseOutcomeIndex(options.outcome);
    const amountUsdcAtomic = usdcDecimalToAtomic(options.amount, 'amount');

    let quote;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      quote = await client.quotes.buy({ marketId, outcomeIndex, amountUsdcAtomic });
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(quote);
      return;
    }
    renderQuote(quote);
  });
