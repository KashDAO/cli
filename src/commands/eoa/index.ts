/**
 * `kash eoa …` — non-custodial direct-to-chain operations using a
 * vanilla EOA (no smart account, no bundler).
 *
 * Wraps `@kashdao/protocol-sdk`'s `createEoaClient`. Best for:
 *   - Market makers with existing EIP-1559 signing infra (web3signer,
 *     Fireblocks, AWS-KMS, etc.).
 *   - Operators who don't want to provision a bundler.
 *   - Lowest per-trade gas overhead.
 *
 * Required profile fields:
 *   - `rpcUrl`        — consumer-owned RPC endpoint
 *   - `defaultChainId`— chain to run on
 *   - `signerKeyRef`  — `file:<path>` or `env:<NAME>` for the EOA key
 *
 * EOA mode does NOT use `smartAccount`, `bundlerUrl`, or
 * `bundlerProvider` — they're SA-mode-only fields.
 *
 * **Surface parity with `kash protocol`.** This namespace mirrors the
 * SA-mode read commands and the trade-execution commands. The
 * UserOp-specific lifecycle (`userop build/simulate/submit/wait/...`)
 * doesn't apply to EOA mode — instead, EOA mode signs serialized
 * EIP-1559 transactions directly. The CLI's `eoa trade {buy,sell,close,approve}`
 * commands run the same all-in-one flow.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildEoaClient } from '../../utils/eoa-client.js';
import { formatAddress, formatGwei, formatUsdcAtomic } from '../../utils/formatting.js';
import {
  parseOptionalPositiveFloat,
  parseOptionalPositiveInt,
  parsePositiveInt,
  readGlobals,
} from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_UINT256,
  type TradeOpSide,
  decimalToAtomicUsdc,
  decimalToAtomicWad,
  extractPartialHash,
  parseDeadlineSec,
  parseOutcomeIndex,
  parseSlippageBps,
  parseUppercaseSide,
  validateAddress,
  validateAddressOptional,
} from '../../utils/trade-input.js';

// ---------------------------------------------------------------------------
// Reads: balance, market, quote, position, allowance, fees
// ---------------------------------------------------------------------------

const balanceCommand = new Command('balance')
  .description(
    "Read on-chain USDC + native gas balances for the EOA (defaults to signer's address)."
  )
  .argument('[account]', "address to read (default: signer's ownerAddress)")
  .action(async (account: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const accountAddress = validateAddressOptional(account, 'account');
    try {
      const resolved = await buildEoaClient({ globals });
      const target = accountAddress ?? resolved.account;
      const [usdc, gas] = await Promise.all([
        resolved.client.account.usdcBalance(target),
        resolved.client.account.gasBalance(target),
      ]);

      const payload = {
        account: target,
        chainId: resolved.chainId,
        usdcAtomic: usdc.toString(),
        gasWei: gas.toString(),
      };
      if (globals.json) {
        printJson(payload);
        return;
      }
      print('');
      print(`  ${style.dim('Account ')} ${formatAddress(target, 10, 8)}`);
      print(`  ${style.dim('Chain   ')} ${String(resolved.chainId)}`);
      print(`  ${style.dim('USDC    ')} ${formatUsdcAtomic(usdc.toString())}`);
      print(
        `  ${style.dim('Gas     ')} ${formatGwei(gas)} gwei ${style.dim(`(${gas.toString()} wei)`)}`
      );
    } catch (cause) {
      throw toCliError(cause);
    }
  });

const marketCommand = new Command('market')
  .description('Read on-chain market state (reserves, supplies, weights, derived probabilities).')
  .argument('<address>', 'market contract address (0x-prefixed)')
  .action(async (address: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const marketAddress = validateAddress(address, 'address');
    try {
      const resolved = await buildEoaClient({ globals });
      const state = await resolved.client.markets.state(marketAddress);
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
        print(`  [${String(outcome.index)}] p=${pct}%`);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

type QuoteOptions = { side: string; outcome: string; amount: string };

const quoteCommand = new Command('quote')
  .description('On-chain price quote for buying or selling an outcome.')
  .argument('<address>', 'market contract address')
  .requiredOption('-s, --side <side>', 'buy | sell')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-a, --amount <decimal>', 'USDC for buy / outcome tokens for sell')
  .action(async (address: string, options: QuoteOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const marketAddress = validateAddress(address, 'address');
    const side = parseUppercaseSide(options.side);
    const outcome = parseOutcomeIndex(options.outcome);
    const amount =
      side === 'BUY'
        ? decimalToAtomicUsdc(options.amount, 'amount')
        : decimalToAtomicWad(options.amount, 'amount');

    try {
      const resolved = await buildEoaClient({ globals });
      const quote = await resolved.client.markets.quote(marketAddress, {
        side,
        outcome,
        amount,
      });
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
      print(`  ${style.dim('Side     ')} ${quote.side}`);
      print(`  ${style.dim('Outcome  ')} ${String(quote.outcomeIndex)}`);
      print(`  ${style.dim('In       ')} ${quote.amountIn.toString()}`);
      print(`  ${style.dim('Out      ')} ${quote.amountOut.toString()}`);
    } catch (cause) {
      throw toCliError(cause);
    }
  });

const positionCommand = new Command('position')
  .description('Read on-chain outcome-token holdings (ERC-1155) for a market.')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .argument('[account]', "address whose holdings to read (default: signer's)")
  .action(async (market: string, account: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const marketAddress = validateAddress(market, 'market');
    const accountAddress = validateAddressOptional(account, 'account');
    try {
      const resolved = await buildEoaClient({ globals });
      const target = accountAddress ?? resolved.account;
      const position = await resolved.client.account.position(target, marketAddress);
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
      print(`  ${style.dim('Account ')} ${formatAddress(target, 10, 8)}`);
      print(`  ${style.dim('Market  ')} ${formatAddress(position.marketAddress, 10, 8)}`);
      print('');
      for (const h of position.holdings) {
        print(`  [${String(h.outcomeIndex)}] balance=${h.balanceWad.toString()} (WAD)`);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

const allowanceCommand = new Command('allowance')
  .description('Read the on-chain USDC allowance from `account` to `spender`.')
  .argument('<spender>', 'spender contract address')
  .argument('[account]', "owner address (default: signer's)")
  .action(async (spender: string, account: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const spenderAddress = validateAddress(spender, 'spender');
    const accountAddress = validateAddressOptional(account, 'account');
    try {
      const resolved = await buildEoaClient({ globals });
      const owner = accountAddress ?? resolved.account;
      const allowance = await resolved.client.account.usdcAllowance(owner, spenderAddress);
      const payload = {
        owner,
        spender,
        chainId: resolved.chainId,
        allowanceAtomic: allowance.toString(),
      };
      if (globals.json) {
        printJson(payload);
        return;
      }
      print('');
      print(`  ${style.dim('Owner    ')} ${formatAddress(owner, 10, 8)}`);
      print(`  ${style.dim('Spender  ')} ${formatAddress(spender, 10, 8)}`);
      print(`  ${style.dim('Allowance')} ${formatUsdcAtomic(allowance.toString())}`);
    } catch (cause) {
      throw toCliError(cause);
    }
  });

const feesCommand = new Command('fees')
  .description('EIP-1559 fee estimate for the configured chain.')
  .option('--blocks <n>', 'number of recent blocks to sample (default 4)')
  .option('--percentile <n>', 'priority-fee percentile per block (1-99, default 50)')
  .option('--base-multiplier <n>', 'multiplier on predicted next-block base fee (default 2.0)')
  .option('--priority-floor-gwei <n>', 'floor for maxPriorityFeePerGas in gwei (default 1)')
  .action(
    async (
      options: {
        blocks?: string;
        percentile?: string;
        baseMultiplier?: string;
        priorityFloorGwei?: string;
      },
      cmd: Command
    ) => {
      const globals = readGlobals(cmd);
      const blocks = parseOptionalPositiveInt(options.blocks, 'blocks');
      const percentile = parseOptionalPositiveInt(options.percentile, 'percentile');
      if (percentile !== undefined && (percentile < 1 || percentile > 99)) {
        throw new CliValidationError('--percentile must be between 1 and 99.');
      }
      const baseMultiplier = parseOptionalPositiveFloat(options.baseMultiplier, 'base-multiplier');
      const priorityFloorGwei = parseOptionalPositiveInt(
        options.priorityFloorGwei,
        'priority-floor-gwei'
      );

      try {
        const resolved = await buildEoaClient({ globals });
        const estimate = await resolved.client.estimateFees({
          ...(blocks === undefined ? {} : { blockCount: blocks }),
          ...(percentile === undefined ? {} : { rewardPercentile: percentile }),
          ...(baseMultiplier === undefined ? {} : { baseMultiplier }),
          ...(priorityFloorGwei === undefined
            ? {}
            : { priorityFeeFloorWei: BigInt(priorityFloorGwei) * 10n ** 9n }),
        });

        const payload = {
          chainId: resolved.chainId,
          maxFeePerGas: estimate.maxFeePerGas.toString(),
          maxPriorityFeePerGas: estimate.maxPriorityFeePerGas.toString(),
        };
        if (globals.json) {
          printJson(payload);
          return;
        }
        print('');
        print(
          `  ${style.dim('maxFee  ')} ${formatGwei(estimate.maxFeePerGas)} gwei (${estimate.maxFeePerGas.toString()} wei)`
        );
        print(
          `  ${style.dim('maxPrio ')} ${formatGwei(estimate.maxPriorityFeePerGas)} gwei (${estimate.maxPriorityFeePerGas.toString()} wei)`
        );
      } catch (cause) {
        throw toCliError(cause);
      }
    }
  );

// ---------------------------------------------------------------------------
// Trade execution: buy, sell, close, approve
// ---------------------------------------------------------------------------

type SharedTradeOptions = {
  outcome?: string;
  slippageBps?: string;
  deadlineSec?: string;
  dryRun?: boolean;
  // Commander stores `--no-X` as `{ x: false }`. Default is undefined
  // (meaning the user did not pass the negative flag); explicit `false`
  // means they did. Same idiom as `--no-overwrite` in `config import`.
  simulate?: boolean;
  wait?: boolean;
  waitTimeoutMs?: string;
};

type Side = TradeOpSide;

const tradeBuyCommand = new Command('buy')
  .description('One-shot BUY (EIP-1559 tx, signed locally and submitted to chain).')
  .argument('<market>', 'market contract address')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-a, --amount <usdc>', 'USDC to spend (decimal)')
  .option('--slippage-bps <n>', 'slippage tolerance in bps (default 50)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit')
  .option('--no-simulate', 'skip eth_call preflight')
  .option('--no-wait', 'fire-and-forget: return tx hash without waiting for inclusion')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .action(
    async (market: string, options: SharedTradeOptions & { amount: string }, cmd: Command) => {
      await runTrade('buy', market, options, cmd);
    }
  );

const tradeSellCommand = new Command('sell')
  .description('One-shot SELL.')
  .argument('<market>', 'market contract address')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-t, --tokens <amount>', 'outcome tokens to sell (WAD decimal)')
  .option('--slippage-bps <n>', 'slippage tolerance in bps (default 50)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit')
  .option('--no-simulate', 'skip eth_call preflight')
  .option('--no-wait', 'fire-and-forget')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .action(
    async (market: string, options: SharedTradeOptions & { tokens: string }, cmd: Command) => {
      await runTrade('sell', market, options, cmd);
    }
  );

const tradeCloseCommand = new Command('close')
  .description('Sell the entire EOA balance for an outcome.')
  .argument('<market>', 'market contract address')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .option('--slippage-bps <n>', 'slippage tolerance in bps (default 50)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit')
  .option('--no-simulate', 'skip eth_call preflight')
  .option('--no-wait', 'fire-and-forget')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .action(async (market: string, options: SharedTradeOptions, cmd: Command) => {
    await runTrade('close', market, options, cmd);
  });

const tradeApproveCommand = new Command('approve')
  .description('USDC approval — required once before the first BUY.')
  .argument('<spender>', 'spender contract address (typically a Market)')
  .option('-a, --amount <usdc>', 'atomic-USDC amount (default unlimited)')
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit')
  .option('--no-simulate', 'skip eth_call preflight')
  .option('--no-wait', 'fire-and-forget')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .action(
    async (
      spender: string,
      options: {
        amount?: string;
        dryRun?: boolean;
        simulate?: boolean;
        wait?: boolean;
        waitTimeoutMs?: string;
      },
      cmd: Command
    ) => {
      const globals = readGlobals(cmd);
      const spenderAddress = validateAddress(spender, 'spender');
      const amount = options.amount ? decimalToAtomicUsdc(options.amount, 'amount') : MAX_UINT256;
      const waitTimeoutMs = options.waitTimeoutMs
        ? parsePositiveInt(options.waitTimeoutMs, 'wait-timeout-ms')
        : undefined;

      try {
        const resolved = await buildEoaClient({ globals });
        const params = {
          account: resolved.account,
          spender: spenderAddress,
          amount,
        };

        if (options.dryRun === true) {
          const built = await resolved.client.trades.prepareApprove(params, {
            simulate: options.simulate !== false,
          });
          emitDryRun('approve', spender, built, globals.json);
          return;
        }

        const sendOptions = {
          simulate: options.simulate !== false,
          wait: options.wait !== false,
          ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
        };
        let result;
        try {
          result = await resolved.client.trades.send.approve(params, sendOptions);
        } catch (cause) {
          // Approves cost gas — same partial-completion concern as
          // buy/sell/close. The EOA SDK's `sendApproveTransaction`
          // shares `dispatch` with the trade calls, so it throws the
          // identical KashChainError(WAIT_RECEIPT_FAILED) shape on
          // post-submit wait timeout. Surface the hash so the
          // operator can verify inclusion before paying gas for a
          // duplicate approve.
          const partialHash = extractPartialTransactionHash(cause);
          if (partialHash !== undefined) {
            if (globals.json) {
              printJson({ transactionHash: partialHash, waited: false, partial: true });
            } else {
              log.warn(
                `Submit succeeded but wait timed out. The approve tx is on-chain — check inclusion via your block explorer for: ${partialHash}`
              );
            }
          }
          throw cause;
        }
        emitSendResult('approve', spender, result, globals.json);
      } catch (cause) {
        throw toCliError(cause);
      }
    }
  );

const tradeCommand = new Command('trade')
  .description('Direct-mode trade execution (vanilla EIP-1559 tx, signed locally).')
  .addHelpText(
    'after',
    `
Wait controls — surface parity with \`kash protocol trade\`:
  --wait-timeout-ms <n>   Cap on the receipt wait (supported).
  --wait-interval-ms      NOT exposed in EOA mode. viem's
                          \`waitForTransactionReceipt\` controls its
                          own polling cadence based on chain block
                          time; the EOA SDK does not pass through a
                          custom interval. Use SA mode
                          (\`kash protocol trade\`) if you need
                          fine-grained interval control.
`
  )
  .addCommand(tradeBuyCommand)
  .addCommand(tradeSellCommand)
  .addCommand(tradeCloseCommand)
  .addCommand(tradeApproveCommand);

// ---------------------------------------------------------------------------
// Top-level eoa namespace
// ---------------------------------------------------------------------------

export const eoaCommand = new Command('eoa')
  .description('Non-custodial direct-to-chain operations using a vanilla EOA (no smart account).')
  .addCommand(balanceCommand)
  .addCommand(marketCommand)
  .addCommand(quoteCommand)
  .addCommand(positionCommand)
  .addCommand(allowanceCommand)
  .addCommand(feesCommand)
  .addCommand(tradeCommand);

// ---------------------------------------------------------------------------
// Trade runner (shared across buy/sell/close)
// ---------------------------------------------------------------------------

async function runTrade(
  side: Side,
  market: string,
  options: SharedTradeOptions & { amount?: string; tokens?: string },
  cmd: Command
): Promise<void> {
  const globals = readGlobals(cmd);
  const marketAddress = validateAddress(market, 'market');
  const outcome = parseOutcomeIndex(options.outcome);
  const slippageBps = options.slippageBps
    ? parseSlippageBps(options.slippageBps)
    : DEFAULT_SLIPPAGE_BPS;
  const deadline = options.deadlineSec ? parseDeadlineSec(options.deadlineSec) : undefined;
  const waitTimeoutMs = options.waitTimeoutMs
    ? parsePositiveInt(options.waitTimeoutMs, 'wait-timeout-ms')
    : undefined;

  let amountUsdc: bigint | undefined;
  let amountTokens: bigint | undefined;
  if (side === 'buy') {
    amountUsdc = decimalToAtomicUsdc(options.amount!, 'amount');
  } else if (side === 'sell') {
    amountTokens = decimalToAtomicWad(options.tokens!, 'tokens');
  }

  try {
    const resolved = await buildEoaClient({ globals });
    // **EOA / SA param-shape note.** The shared `BuildBuyParams` /
    // `BuildSellParams` shapes the SDK exposes still use a
    // `smartAccount: Hex` field name in EOA mode for back-compat with
    // SA-mode call sites. The SDK accepts the EOA address here as the
    // signing-account hint — see protocol-sdk's `eoa/trades/build.ts`.
    // The pinning-test in `tests/component/eoa.test.ts` asserts the
    // SDK still respects this aliasing so SDK upgrades that tighten
    // the field name surface as a test failure instead of a silent
    // mis-trade.
    const baseParams = {
      account: resolved.account,
      smartAccount: resolved.account,
      outcome,
      maxSlippageBps: slippageBps,
      ...(deadline === undefined ? {} : { deadline }),
    };
    const opts = { simulate: options.simulate !== false };

    if (options.dryRun === true) {
      let built;
      if (side === 'buy') {
        built = await resolved.client.trades.prepareBuy(
          marketAddress,
          { ...baseParams, amountUsdc: amountUsdc! },
          opts
        );
      } else if (side === 'sell') {
        built = await resolved.client.trades.prepareSell(
          marketAddress,
          { ...baseParams, amountTokens: amountTokens! },
          opts
        );
      } else {
        built = await resolved.client.trades.prepareClosePosition(marketAddress, baseParams, opts);
      }
      emitDryRun(side, market, built, globals.json);
      return;
    }

    const sendOptions = {
      simulate: options.simulate !== false,
      wait: options.wait !== false,
      ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
    };

    let result;
    try {
      if (side === 'buy') {
        result = await resolved.client.trades.send.buy(
          marketAddress,
          { ...baseParams, amountUsdc: amountUsdc! },
          sendOptions
        );
      } else if (side === 'sell') {
        result = await resolved.client.trades.send.sell(
          marketAddress,
          { ...baseParams, amountTokens: amountTokens! },
          sendOptions
        );
      } else {
        result = await resolved.client.trades.send.closePosition(
          marketAddress,
          baseParams,
          sendOptions
        );
      }
    } catch (cause) {
      // Partial-completion guard symmetric to the SA-mode path. The
      // EOA SDK throws KashChainError with `code: 'WAIT_RECEIPT_FAILED'`
      // and `context.transactionHash` when submit succeeded but the
      // wait phase timed out (see
      // `protocol-sdk/src/eoa/trades/send.ts:273-281`). Surface that
      // hash so the operator doesn't pay gas and lose the inclusion
      // pointer. The discriminator is narrow on purpose so unrelated
      // KashChainErrors (chain RPC failures, contract reverts) don't
      // get mis-reported as partial completions.
      const partialHash = extractPartialTransactionHash(cause);
      if (partialHash !== undefined) {
        if (globals.json) {
          printJson({ transactionHash: partialHash, waited: false, partial: true });
        } else {
          log.warn(
            `Submit succeeded but wait timed out. The tx is on-chain — check inclusion via your block explorer for: ${partialHash}`
          );
        }
      }
      throw cause;
    }
    emitSendResult(side, market, result, globals.json);
  } catch (cause) {
    throw toCliError(cause);
  }
}

/**
 * EOA-mode wrapper around the canonical `extractPartialHash` factory
 * (`utils/trade-input.ts`). Pinned to the wait-receipt-failed code so
 * pre-submit `KashChainError` variants (`CHAIN_RPC_FAILED`, etc.)
 * don't masquerade as partial completions.
 *
 * SDK throw site: `protocol-sdk/src/eoa/trades/send.ts:273-281`.
 */
function extractPartialTransactionHash(cause: unknown): `0x${string}` | undefined {
  return extractPartialHash(cause, {
    code: 'WAIT_RECEIPT_FAILED',
    contextKey: 'transactionHash',
  });
}

// ---------------------------------------------------------------------------
// Output emitters
// ---------------------------------------------------------------------------

type BuiltTxLike = {
  transaction: Record<string, unknown>;
  transactionHash: `0x${string}`;
};

function emitDryRun(
  side: Side | 'approve',
  target: string,
  built: BuiltTxLike,
  json: boolean
): void {
  if (json) {
    // `printJson`'s jsonReplacer is the single source of truth for
    // bigint-in-JSON: it coerces every bigint field on `transaction`
    // to a decimal string. No pre-conversion needed here.
    printJson({
      side,
      target,
      transaction: built.transaction,
      transactionHash: built.transactionHash,
      dryRun: true,
    });
    return;
  }
  print('');
  print(`  ${style.bold('Dry run')} — transaction prepared but NOT signed/submitted.`);
  print(`  ${style.dim('Side  ')} ${side}`);
  print(`  ${style.dim('Target')} ${formatAddress(target, 10, 8)}`);
  print(`  ${style.dim('Hash  ')} ${built.transactionHash}`);
  print('');
  print(style.dim('Re-run without --dry-run to sign and submit.'));
}

type SendResultLike =
  | { transactionHash: `0x${string}` }
  | {
      transactionHash: `0x${string}`;
      blockNumber: bigint;
      success: boolean;
      gasUsed: bigint;
    };

function emitSendResult(
  side: Side | 'approve',
  target: string,
  result: SendResultLike,
  json: boolean
): void {
  const waited = 'blockNumber' in result;
  const payload = waited
    ? {
        side,
        target,
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber.toString(),
        success: result.success,
        gasUsed: result.gasUsed.toString(),
      }
    : {
        side,
        target,
        transactionHash: result.transactionHash,
        waited: false,
      };

  if (json) {
    printJson(payload);
    return;
  }

  print('');
  if (waited) {
    if (result.success) {
      log.success(`${side} included in block ${result.blockNumber.toString()}.`);
    } else {
      log.error(`${side} included but reverted on-chain.`);
    }
    print(`  ${style.dim('Tx     ')} ${result.transactionHash}`);
    print(`  ${style.dim('Block  ')} ${result.blockNumber.toString()}`);
    print(`  ${style.dim('Gas    ')} ${result.gasUsed.toString()}`);
  } else {
    log.success(`${side} submitted (fire-and-forget).`);
    print(`  ${style.dim('Tx ')} ${result.transactionHash}`);
  }
}

// ---------------------------------------------------------------------------
// EOA-mode-only helpers (the shared trade-input parsers live in
// `utils/trade-input.ts`).
// ---------------------------------------------------------------------------

// `formatGwei` lives in `utils/formatting.ts` — shared with
// protocol/fees and balance renderers.
// `parseOptionalPositiveInt` / `parseOptionalPositiveFloat` live in
// `utils/global-options.ts` — single source for positive-bound parsers
// across every CLI command.
