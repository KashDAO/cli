/**
 * `kash quote sell <marketId>` — price quote for selling outcome tokens.
 *
 * Requires API key with `markets:quote` scope (granted by default on every
 * tier; split from `markets:read` because quotes are RPC-heavy). The SDK's
 * `quotes.sell` returns the AMM's `quoteSellExactTokensIn` view: how much
 * USDC the trader receives (after fees) for surrendering the given tokens.
 *
 * `--tokens` is human-decimal token quantity (e.g. "1.5" for one and a
 * half outcome tokens). The CLI converts to WAD-18 before calling the
 * SDK.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { readGlobals } from '../../utils/global-options.js';
import { printJson } from '../../utils/output.js';
import { parseOutcomeIndex } from '../../utils/trade-input.js';

import { renderQuote, tokenDecimalToWad } from './shared.js';

type SellQuoteOptions = {
  outcome: string;
  tokens: string;
};

export const sellQuoteCommand = new Command('sell')
  .description('Quote a sell of outcome tokens back into USDC.')
  .argument('<marketId>', 'market UUID')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption(
    '-t, --tokens <amount>',
    'outcome tokens to surrender (decimal, e.g. "1.5") — quote-side input shape'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash quote sell 9f0b... --outcome 0 --tokens 1
  $ kash quote sell 9f0b... --outcome 1 --tokens 0.5 --json --quiet | jq -r '.usdcOut'

Notes:
  This is a quote on a tokens-in figure. To EXECUTE a sell, run
  \`kash trade sell\` — that command takes \`--amount <usdc>\` (the target
  USDC out, not tokens-in). The unit shift is intentional: the public
  API exposes USDC as the canonical user-facing amount.
`
  )
  .action(async (marketId: string, options: SellQuoteOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const outcomeIndex = parseOutcomeIndex(options.outcome);
    const tokensInWad = tokenDecimalToWad(options.tokens, 'tokens');

    let quote;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      quote = await client.quotes.sell({ marketId, outcomeIndex, tokensInWad });
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(quote);
      return;
    }
    renderQuote(quote);
  });
