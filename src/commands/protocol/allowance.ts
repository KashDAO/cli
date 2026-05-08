/**
 * `kash protocol allowance <spender> [account]` — read the on-chain
 * USDC allowance from `account` to `spender`. Used to skip `approve`
 * calls when an existing allowance is already sufficient (the
 * conventional first-trade pattern).
 *
 * Defaults `account` to the active profile's `smartAccount`.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress, formatUsdcAtomic } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';
import { validateAddress, validateAddressOptional } from '../../utils/trade-input.js';

export const allowanceCommand = new Command('allowance')
  .description('Read the on-chain USDC allowance from `account` to `spender`.')
  .argument('<spender>', 'spender contract address (e.g. a market) — 0x-prefixed')
  .argument('[account]', "owner address (default: profile's smartAccount)")
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol allowance 0xMarket...
  $ kash protocol allowance 0xMarket... 0xOwner...
  $ kash protocol allowance 0xMarket... --json --quiet | jq -r '.allowanceAtomic'

Notes:
  - The allowance is returned in USDC atomic units (6 decimals). A
    value larger than the trade's atomic-USDC input means \`approve\`
    can be skipped on the next trade.
`
  )
  .action(async (spender: string, account: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const spenderAddress = validateAddress(spender, 'spender');
    const accountAddress = validateAddressOptional(account, 'account');

    try {
      const resolved = await buildDirectClient({ globals });
      const owner = accountAddress ?? resolved.smartAccount;
      const allowance = await resolved.client.account.usdcAllowance(owner, spenderAddress);

      const payload = {
        owner,
        spender: spenderAddress,
        chainId: resolved.chainId,
        allowanceAtomic: allowance.toString(),
      };

      if (globals.json) {
        printJson(payload);
        return;
      }

      print('');
      print(`  ${style.dim('Owner   ')} ${formatAddress(owner, 10, 8)}`);
      print(`  ${style.dim('Spender ')} ${formatAddress(spenderAddress, 10, 8)}`);
      print(
        `  ${style.dim('Allowance')} ${formatUsdcAtomic(allowance.toString())} ${style.dim(`(${allowance.toString()} atomic)`)}`
      );
    } catch (cause) {
      throw toCliError(cause);
    }
  });
