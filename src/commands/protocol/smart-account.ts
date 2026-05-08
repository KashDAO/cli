/**
 * `kash protocol smart-account` — derive smart-account address +
 * check deployment status without sending a UserOp.
 *
 * Two read-only operations:
 *
 *   - `compute --owner 0x… [--salt n]` — derive the deterministic
 *     SimpleAccountFactory address for an EOA owner. Same address
 *     whether deployed or not.
 *   - `is-deployed [address]` — check whether a smart account has
 *     bytecode at its address. A `false` result is normal for a
 *     never-traded SA (the first UserOp deploys it via factory data).
 *
 * Wraps `client.account.computeAddress` and `client.account.isDeployed`
 * from `@kashdao/protocol-sdk`. Read-only — uses the existing
 * `noopSigner` plumbing.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';
import { validateAddress, validateAddressOptional } from '../../utils/trade-input.js';

type ComputeOptions = {
  owner: string;
  salt?: string;
};

const computeCommand = new Command('compute')
  .description('Derive the deterministic smart-account address for an EOA owner.')
  .requiredOption('-o, --owner <address>', 'EOA owner address (0x-prefixed)')
  .option('-s, --salt <n>', 'optional salt as a non-negative integer (default 0)', '0')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol smart-account compute --owner 0xEoa...
  $ kash protocol smart-account compute --owner 0xEoa... --salt 1
  $ kash protocol smart-account compute --owner 0xEoa... --json --quiet | jq -r '.address'
`
  )
  .action(async (options: ComputeOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const ownerAddress = validateAddress(options.owner, 'owner');

    let salt: bigint | undefined;
    if (options.salt !== undefined) {
      let parsed: bigint;
      try {
        parsed = BigInt(options.salt);
      } catch {
        throw new CliValidationError(
          '--salt must be a non-negative integer (decimal or 0x-hex).',
          `Got "${options.salt}".`,
          'salt'
        );
      }
      if (parsed < 0n) {
        throw new CliValidationError(
          '--salt must be non-negative.',
          `Got "${options.salt}".`,
          'salt'
        );
      }
      salt = parsed === 0n ? undefined : parsed;
    }

    try {
      const resolved = await buildDirectClient({ globals });
      const address = await resolved.client.account.computeAddress(ownerAddress, salt);

      const payload = {
        owner: ownerAddress,
        salt: (salt ?? 0n).toString(),
        chainId: resolved.chainId,
        address,
      };

      if (globals.json) {
        printJson(payload);
        return;
      }

      print('');
      print(`  ${style.dim('Owner  ')} ${formatAddress(ownerAddress, 10, 8)}`);
      print(`  ${style.dim('Salt   ')} ${(salt ?? 0n).toString()}`);
      print(`  ${style.dim('Address')} ${address}`);
    } catch (cause) {
      throw toCliError(cause);
    }
  });

const isDeployedCommand = new Command('is-deployed')
  .description('Check whether a smart account has bytecode (i.e. has been deployed on-chain).')
  .argument('[address]', "smart account address (default: profile's smartAccount)")
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol smart-account is-deployed
  $ kash protocol smart-account is-deployed 0xSa...
  $ kash protocol smart-account is-deployed --json --quiet | jq -r '.deployed'
`
  )
  .action(async (address: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const addressOverride = validateAddressOptional(address, 'address');

    try {
      const resolved = await buildDirectClient({ globals });
      const target = addressOverride ?? resolved.smartAccount;
      const deployed = await resolved.client.account.isDeployed(target);

      const payload = {
        address: target,
        chainId: resolved.chainId,
        deployed,
      };

      if (globals.json) {
        printJson(payload);
        return;
      }

      print('');
      print(`  ${style.dim('Address ')} ${formatAddress(target, 10, 8)}`);
      print(
        `  ${style.dim('Deployed')} ${deployed ? style.success('yes') : style.dim('no — first UserOp will deploy')}`
      );
    } catch (cause) {
      throw toCliError(cause);
    }
  });

export const smartAccountCommand = new Command('smart-account')
  .description('Smart-account address derivation and deployment-status checks.')
  .addCommand(computeCommand)
  .addCommand(isDeployedCommand);
