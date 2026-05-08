/**
 * `kash protocol token-id --market-id <bigint> --outcome <n>` —
 * compute the ERC-1155 token id for a `(marketId, outcomeIndex)`
 * pair. Pure offline computation; no RPC required.
 *
 * Wraps `tokenIdFor` from `@kashdao/protocol-sdk`. The `marketId`
 * argument is the on-chain numeric id (read from `IMarket.marketId()`)
 * — NOT the market's contract address.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';

type TokenIdOptions = {
  marketId: string;
  outcome: string;
};

export const tokenIdCommand = new Command('token-id')
  .description(
    'Compute the ERC-1155 token id for a (marketId, outcomeIndex) pair (offline; no RPC).'
  )
  .requiredOption(
    '-m, --market-id <bigint>',
    'on-chain numeric market id (decimal or 0x-prefixed hex)'
  )
  .requiredOption('-o, --outcome <index>', 'outcome index (0-255)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol token-id --market-id 42 --outcome 0
  $ kash protocol token-id --market-id 0x2a --outcome 1 --json --quiet | jq -r '.tokenId'

Notes:
  - The numeric \`marketId\` is the on-chain id read from
    \`IMarket(<addr>).marketId()\`. It's NOT the same as the market
    contract address.
  - The token id encoding is \`(marketId << 8) | outcomeIndex\`,
    matching the on-chain \`OutcomeTokens1155\` contract.
`
  )
  .action(async (options: TokenIdOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    let marketId: bigint;
    try {
      marketId = BigInt(options.marketId);
    } catch {
      throw new CliValidationError(
        '--market-id must be a non-negative integer (decimal or 0x-hex).',
        `Got "${options.marketId}".`,
        'market-id'
      );
    }
    if (marketId < 0n) {
      throw new CliValidationError(
        '--market-id must be non-negative.',
        `Got "${options.marketId}".`,
        'market-id'
      );
    }

    const outcomeIndex = Number.parseInt(options.outcome, 10);
    if (!Number.isFinite(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 255) {
      throw new CliValidationError(
        '--outcome must be an integer between 0 and 255.',
        `Got "${options.outcome}".`,
        'outcome'
      );
    }

    try {
      // Lazy-import the protocol-sdk so this small offline helper
      // doesn't pull viem unnecessarily for the rest of the CLI.
      const { tokenIdFor } = await import('@kashdao/protocol-sdk');
      const tokenId = tokenIdFor(marketId, outcomeIndex);

      const payload = {
        marketId: marketId.toString(),
        outcomeIndex,
        tokenId: tokenId.toString(),
        tokenIdHex: `0x${tokenId.toString(16)}`,
      };

      if (globals.json) {
        printJson(payload);
        return;
      }

      print('');
      print(`  ${style.dim('Market id  ')} ${marketId.toString()}`);
      print(`  ${style.dim('Outcome    ')} ${String(outcomeIndex)}`);
      print(`  ${style.dim('Token id   ')} ${tokenId.toString()}`);
      print(`  ${style.dim('  (hex)    ')} 0x${tokenId.toString(16)}`);
    } catch (cause) {
      throw toCliError(cause);
    }
  });
