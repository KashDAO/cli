/**
 * `kash protocol …` — non-custodial direct-to-chain operations.
 *
 * Wraps `@kashdao/protocol-sdk`. Every command in this namespace
 * reads from the chain via the consumer's RPC and, for write paths,
 * signs UserOps locally with the configured signer. Zero Kash backend
 * dependency.
 *
 * Required profile fields for any subcommand:
 *
 *   - `rpcUrl`        — consumer-owned RPC endpoint
 *   - `smartAccount`  — ERC-4337 account whose funds are used
 *   - `defaultChainId`— chain to run on (8453 mainnet, 84532 sepolia)
 *
 * Read-only subcommands (`balance`, `market`, `quote`) use a no-op
 * signer and don't require `signerKeyRef`; write subcommands do.
 */

import { Command } from 'commander';

import { allowanceCommand } from './allowance.js';
import { balanceCommand } from './balance.js';
import { decodeRevertCommand } from './decode-revert.js';
import { feesCommand } from './fees.js';
import { marketCommand } from './market.js';
import { positionCommand } from './position.js';
import { quoteCommand } from './quote.js';
import { smartAccountCommand } from './smart-account.js';
import { tokenIdCommand } from './token-id.js';
import { tradeCommand } from './trade.js';
import { useropCommand } from './userop.js';
import { watchCommand } from './watch.js';

export const protocolCommand = new Command('protocol')
  .description('Non-custodial direct-to-chain operations (uses @kashdao/protocol-sdk).')
  .addCommand(balanceCommand)
  .addCommand(marketCommand)
  .addCommand(quoteCommand)
  .addCommand(positionCommand)
  .addCommand(allowanceCommand)
  .addCommand(smartAccountCommand)
  .addCommand(feesCommand)
  .addCommand(tokenIdCommand)
  .addCommand(decodeRevertCommand)
  .addCommand(tradeCommand)
  .addCommand(useropCommand)
  .addCommand(watchCommand);
