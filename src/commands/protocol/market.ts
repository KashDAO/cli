/**
 * `kash protocol market <market-address>` — read on-chain market state.
 *
 * Direct mode, read-only. Uses the protocol-sdk's `markets.state`
 * which returns the aggregated reserves, supplies, weights, and
 * derived per-outcome probabilities.
 *
 * The custodial equivalent is `kash markets get <uuid>`. The two are
 * deliberately separate commands because the inputs differ (UUID vs
 * 0x address) and the outputs differ (API-projected `MarketResource`
 * vs on-chain `MarketState`). Operators using direct mode should
 * never confuse on-chain state with the API's denormalised view.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress, formatWad } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';
import { validateAddress } from '../../utils/trade-input.js';

export const marketCommand = new Command('market')
  .description('Read on-chain market state (reserves, supplies, weights, derived probabilities).')
  .argument('<address>', 'market contract address (0x-prefixed)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol market 0xabc...
  $ kash protocol market 0xabc... --json --quiet | jq '.outcomes'
`
  )
  .action(async (address: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);

    validateAddress(address, 'address');

    let resolved;
    let state;
    try {
      resolved = await buildDirectClient({ globals });
      state = await resolved.client.markets.state(address as `0x${string}`);
    } catch (cause) {
      throw toCliError(cause);
    }

    // Convert bigints to strings on the JSON path so consumers can
    // round-trip through `JSON.stringify` losslessly.
    const payload = {
      marketAddress: state.marketAddress,
      chainId: resolved.chainId,
      status: state.status,
      readAt: state.readAt.toString(),
      reserveWad: state.reserveWad.toString(),
      outcomes: state.outcomes.map((o) => ({
        index: o.index,
        outstandingTokensWad: o.outstandingTokensWad.toString(),
        weightWad: o.weightWad.toString(),
        probability: o.probability,
      })),
    };

    if (globals.json) {
      printJson(payload);
      return;
    }

    print('');
    print(`  ${style.dim('Market   ')} ${formatAddress(state.marketAddress, 10, 8)}`);
    print(`  ${style.dim('Status   ')} ${state.status}`);
    print(`  ${style.dim('Outcomes ')} ${String(state.outcomes.length)}`);
    print('');
    for (const outcome of state.outcomes) {
      const pct = (outcome.probability * 100).toFixed(2);
      print(
        `  [${String(outcome.index)}] p=${pct}%  outstanding=${formatWad(outcome.outstandingTokensWad)}  weight=${formatWad(outcome.weightWad)}`
      );
    }
  });
