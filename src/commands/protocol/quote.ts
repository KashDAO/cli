/**
 * `kash protocol quote <market-address>` — on-chain price quote.
 *
 * Direct mode, read-only. Calls `markets.quote` on the AMM contract.
 * The Kash-orchestrated equivalent is `kash quote buy/sell` which hits the
 * API; this version reads directly from chain via the configured RPC.
 *
 * Input units mirror the protocol-sdk's contract: `--amount` is
 * USDC (decimal, e.g. "10") on BUY, outcome tokens (decimal, e.g.
 * "1.5") on SELL. The CLI converts to atomic-6 / WAD-18 before
 * calling the SDK.
 *
 * Output:
 *
 * ```jsonc
 * {
 *   "side": "BUY",
 *   "outcomeIndex": 0,
 *   "amountIn": "10000000",            // atomic-6 USDC
 *   "amountOut": "16234567890123456",  // WAD-18 outcome tokens
 *   "reserveAfterWad": "...",
 *   "pricesAfterWad": ["...", "..."]
 * }
 * ```
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress, formatUsdcAtomic, formatWad } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';
import {
  decimalToAtomicUsdc,
  decimalToAtomicWad,
  parseOutcomeIndex,
  parseUppercaseSide,
  validateAddress,
} from '../../utils/trade-input.js';

type QuoteOptions = {
  side: string;
  outcome: string;
  amount: string;
};

export const quoteCommand = new Command('quote')
  .description('On-chain price quote for buying or selling an outcome.')
  .argument('<address>', 'market contract address (0x-prefixed)')
  .requiredOption('-s, --side <buy|sell>', 'trade side: buy or sell')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption(
    '-a, --amount <decimal>',
    'amount: USDC decimal for buy (e.g. "10"), outcome-token decimal for sell (e.g. "1.5")'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol quote 0xabc... --side buy --outcome 0 --amount 10
  $ kash protocol quote 0xabc... --side sell --outcome 1 --tokens 1.5 --json
`
  )
  .action(async (address: string, options: QuoteOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const marketAddress = validateAddress(address, 'address');
    const side = parseUppercaseSide(options.side, 'side');
    const outcome = parseOutcomeIndex(options.outcome);
    const amount =
      side === 'BUY'
        ? decimalToAtomicUsdc(options.amount, 'amount')
        : decimalToAtomicWad(options.amount, 'amount');

    let resolved;
    let quote;
    try {
      resolved = await buildDirectClient({ globals });
      quote = await resolved.client.markets.quote(marketAddress, {
        side,
        outcome,
        amount,
      });
    } catch (cause) {
      throw toCliError(cause);
    }

    const payload = {
      side: quote.side,
      outcomeIndex: quote.outcomeIndex,
      amountIn: quote.amountIn.toString(),
      amountOut: quote.amountOut.toString(),
      reserveAfterWad: quote.reserveAfterWad.toString(),
      pricesAfterWad: quote.pricesAfterWad.map((p) => p.toString()),
    };

    if (globals.json) {
      printJson(payload);
      return;
    }

    print('');
    print(`  ${style.dim('Market    ')} ${formatAddress(address, 10, 8)}`);
    print(`  ${style.dim('Action    ')} ${quote.side} outcome ${String(quote.outcomeIndex)}`);
    if (quote.side === 'BUY') {
      print(`  ${style.dim('Spend     ')} ${formatUsdcAtomic(quote.amountIn)}`);
      print(`  ${style.dim('Tokens out')} ${formatWad(quote.amountOut)}`);
    } else {
      print(`  ${style.dim('Tokens in ')} ${formatWad(quote.amountIn)}`);
      print(`  ${style.dim('USDC out  ')} ${formatUsdcAtomic(quote.amountOut)}`);
    }
    print(
      `  ${style.dim('Probs after')} [${quote.pricesAfterWad
        .map((p) => `${((Number(p) / 1e18) * 100).toFixed(2)}%`)
        .join(', ')}]`
    );
  });
