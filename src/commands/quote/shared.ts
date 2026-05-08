/**
 * Shared rendering for `kash quote buy/sell` output.
 *
 * The buy and sell endpoints differ in input units (USDC atomic-6
 * vs. WAD-18) but share the same output shape: a flat `Quote` with
 * the embedded market summary. Centralising the render avoids
 * drift between the two commands.
 */

import { colorStatus, formatUsdcAtomic, formatWad, shortId } from '../../utils/formatting.js';
import { log, print, style } from '../../utils/output.js';
import { decimalToAtomicUsdc, decimalToAtomicWad } from '../../utils/trade-input.js';

import type { Quote, QuoteBuyDetail, QuoteSellDetail } from '@kashdao/sdk';

/** Render either a buy or a sell quote in human mode. */
export function renderQuote(quote: Quote & (QuoteBuyDetail | QuoteSellDetail)): void {
  print('');
  print(
    `  ${style.dim('Market    ')} ${shortId(quote.market.id)} (${colorStatus(quote.market.status ?? 'UNKNOWN')})`
  );
  print(
    `  ${style.dim('Outcome   ')} ${String(quote.outcomeIndex)}: ${quote.market.outcomes[quote.outcomeIndex]?.label ?? '(unknown)'}`
  );
  print(`  ${style.dim('Action    ')} ${quote.action}`);
  if (quote.action === 'buy') {
    print(`  ${style.dim('Spend     ')} ${formatUsdcAtomic(quote.amountIn)}`);
    print(`  ${style.dim('Tokens out')} ${formatWad(quote.tokensOut)}`);
  } else {
    print(`  ${style.dim('Tokens in ')} ${formatWad(quote.tokensIn)}`);
    print(`  ${style.dim('Receive   ')} ${formatUsdcAtomic(quote.usdcOut)}`);
    print(`  ${style.dim('Gross     ')} ${formatWad(quote.grossRelease)} (before fees)`);
  }
  print(`  ${style.dim('Eff. price')} ${quote.effectivePrice.toFixed(6)} USDC/token`);
  if (quote.impliedProbability !== null) {
    print(`  ${style.dim('Implied p ')} ${(quote.impliedProbability * 100).toFixed(2)}%`);
  }

  // Cross-link to the natural next command. A quote is a planning step;
  // the operator's next call is almost always to actually execute the
  // trade. Surface the exact command so they don't bounce through
  // `--help`. Note the unit shift on `sell`: quote takes `--tokens`,
  // trade takes `--amount` in USDC (the documented API contract).
  if (quote.action === 'buy') {
    log.info(
      `To execute: kash trade buy ${quote.market.id} --outcome ${String(quote.outcomeIndex)} --amount <usdc>`
    );
  } else {
    log.info(
      `To execute: kash trade sell ${quote.market.id} --outcome ${String(quote.outcomeIndex)} --amount <usdc>  (USDC target, not tokens-in)`
    );
  }
}

/**
 * Convert a human USDC decimal string ("10", "12.50", "0.000001") to
 * the atomic-6 integer string the SDK expects.
 *
 * Thin string-typed wrapper around the canonical
 * `decimalToAtomicUsdc` (which returns bigint). The SDK accepts the
 * decimal-string shape over the wire, so we stringify here once
 * rather than coupling every call site to bigint→string conversion.
 */
export function usdcDecimalToAtomic(decimal: string, name: string): string {
  return decimalToAtomicUsdc(decimal, name).toString();
}

/**
 * Convert a human token decimal string ("1", "1.5", "0.0001") to the
 * WAD-18 integer string the SDK expects. String-typed wrapper around
 * the canonical `decimalToAtomicWad`.
 */
export function tokenDecimalToWad(decimal: string, name: string): string {
  return decimalToAtomicWad(decimal, name).toString();
}
