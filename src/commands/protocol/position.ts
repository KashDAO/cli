/**
 * `kash protocol position <market-address> [account]` — read on-chain
 * outcome-token holdings (ERC-1155) for a single market.
 *
 * Direct mode, read-only. Uses the protocol-sdk's
 * `client.account.position(account, market)` which fans out a
 * `balanceOfBatch` against `OutcomeTokens1155`. Defaults `account` to
 * the active profile's `smartAccount`.
 *
 * Distinct from `kash portfolio positions` — that hits the public API
 * (Kash-orchestrated). This is on-chain truth, useful for direct-mode operators
 * verifying their balances independently.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress, formatWad } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';
import { validateAddress, validateAddressOptional } from '../../utils/trade-input.js';

export const positionCommand = new Command('position')
  .description('Read on-chain outcome-token holdings (ERC-1155) for a market.')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .argument(
    '[account]',
    "EOA or smart-account address whose holdings to read (default: profile's smartAccount)"
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol position 0xMarket...
  $ kash protocol position 0xMarket... 0xOther...
  $ kash protocol position 0xMarket... --json --quiet | jq '.holdings[].balanceWad'
`
  )
  .action(async (market: string, account: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);

    const marketAddr = validateAddress(market, 'market');
    const accountAddr = validateAddressOptional(account, 'account');

    let resolved;
    let position;
    try {
      resolved = await buildDirectClient({ globals });
      const target = accountAddr ?? resolved.smartAccount;
      position = await resolved.client.account.position(target, marketAddr);

      const payload = {
        account: target,
        marketAddress: position.marketAddress,
        chainId: resolved.chainId,
        numOutcomes: position.numOutcomes,
        holdings: position.holdings.map((h) => ({
          outcomeIndex: h.outcomeIndex,
          balanceWad: h.balanceWad.toString(),
        })),
      };

      if (globals.json) {
        printJson(payload);
        return;
      }

      print('');
      print(`  ${style.dim('Account  ')} ${formatAddress(target, 10, 8)}`);
      print(`  ${style.dim('Market   ')} ${formatAddress(position.marketAddress, 10, 8)}`);
      print(`  ${style.dim('Outcomes ')} ${String(position.numOutcomes)}`);
      print('');
      for (const h of position.holdings) {
        const balanceLabel = formatWad(h.balanceWad);
        print(
          `  [${String(h.outcomeIndex)}] balance=${balanceLabel} ${style.dim(`(${h.balanceWad.toString()} WAD)`)}`
        );
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });
