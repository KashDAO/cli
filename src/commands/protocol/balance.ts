/**
 * `kash protocol balance [account]` — read on-chain balances for a
 * smart account.
 *
 * Direct mode, read-only. Uses the protocol-sdk's `account.usdcBalance`
 * + `account.gasBalance`. Defaults to the active profile's
 * `smartAccount` when no argument is given so most operators run a
 * bare `kash protocol balance` for their own account.
 *
 * Output (JSON shape pinned via `OnChainBalanceSchema`):
 *
 * ```jsonc
 * {
 *   "account": "0x...",
 *   "chainId": 8453,
 *   "usdcAtomic": "12345000000",
 *   "gasWei": "12300000000000000"
 * }
 * ```
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress, formatBigDecimal, formatUsdcAtomic } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';
import { validateAddressOptional } from '../../utils/trade-input.js';

export const balanceCommand = new Command('balance')
  .description("Read on-chain USDC + gas balance for a smart account (defaults to the profile's).")
  .argument('[account]', "smart-account address (defaults to the active profile's smartAccount)")
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol balance
  $ kash protocol balance 0xabc...
  $ kash protocol balance --json --quiet | jq '.usdcAtomic'

Direct-mode requires rpcUrl + smartAccount + signerKeyRef configured
on the active profile (signer is loaded but never invoked for reads).
`
  )
  .action(async (account: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const accountOverride = validateAddressOptional(account, 'account');

    let resolved;
    try {
      resolved = await buildDirectClient({ globals });
    } catch (cause) {
      throw toCliError(cause);
    }
    const target = accountOverride ?? resolved.smartAccount;

    let usdcAtomic: bigint;
    let gasWei: bigint;
    try {
      [usdcAtomic, gasWei] = await Promise.all([
        resolved.client.account.usdcBalance(target),
        resolved.client.account.gasBalance(target),
      ]);
    } catch (cause) {
      throw toCliError(cause);
    }

    const payload = {
      account: target,
      chainId: resolved.chainId,
      usdcAtomic: usdcAtomic.toString(),
      gasWei: gasWei.toString(),
    };

    if (globals.json) {
      printJson(payload);
      return;
    }

    print('');
    print(`  ${style.dim('Account     ')} ${formatAddress(target, 10, 8)}`);
    print(`  ${style.dim('Chain       ')} ${String(resolved.chainId)}`);
    print(`  ${style.dim('USDC        ')} ${formatUsdcAtomic(usdcAtomic.toString())}`);
    print(
      `  ${style.dim('ETH (gas)   ')} ${formatBigDecimal(gasWei, { baseDecimals: 18, displayDecimals: 6 })} ETH`
    );
  });
