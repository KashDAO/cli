/**
 * `kash protocol …` — self-orchestrated direct-to-chain operations.
 *
 * Wraps `@kashdao/protocol-sdk`. Every command in this namespace
 * reads from the chain via the consumer's RPC and, for write paths,
 * signs UserOps locally with the configured signer. Zero Kash backend
 * dependency.
 *
 * Both this self-orchestrated mode and the default Kash-orchestrated
 * mode (`kash markets`, `kash trade`, …) are fully non-custodial —
 * user funds always live in Privy-managed MPC smart accounts the user
 * controls; Kash never holds keys on either path. The split is about
 * who builds and submits the UserOp, not who has custody.
 *
 * Required profile fields for any subcommand:
 *
 *   - `rpcUrl`        — consumer-owned RPC endpoint
 *   - `smartAccount`  — ERC-4337 account whose funds are used
 *   - `defaultChain`  — an `evm:` chain to run on (8453 mainnet, 84532
 *                       sepolia); a Solana profile falls back to Base mainnet,
 *                       because this namespace is EVM/ERC-4337 only
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
  .description(
    "EVM/Base only: self-orchestrated direct-to-chain operations via ERC-4337 smart accounts (uses @kashdao/protocol-sdk). For Solana markets — Kash's canonical chain — use the API-backed commands (kash markets, kash trade, kash redeem). Non-custodial either way; the difference is who builds and submits trades."
  )
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
