/**
 * `kash protocol trade buy|sell|close|approve` — one-shot direct-mode
 * trade execution. Wraps `client.trades.send.{buy,sell,closePosition,approve}`
 * which prepares → simulates → signs → submits → (optionally) waits
 * for inclusion.
 *
 * **Real-money paths.** These commands sign and submit transactions
 * with the configured `signerKeyRef` against the configured
 * `bundlerUrl`/`bundlerProvider`. Use `--dry-run` to preview without
 * sending. Use `--no-wait` for fire-and-forget (returns userOpHash
 * immediately).
 *
 * **Safety:**
 *   - The SDK's `prepare*` step always runs simulation (`eth_call`
 *     preflight) before signing — pass `--no-simulate` to skip if
 *     you've already validated and want the round-trip back.
 *   - On simulation revert, throws `KashSimulationRevertedError`
 *     before the consumer pays signer-infra round-trips.
 *   - The signer's owner address is recovered from the signed hash
 *     and compared to `signer.ownerAddress`; mismatches throw
 *     `KashSignerError(STALE_USEROP_HASH)`.
 */

import { Command } from 'commander';
import ora from 'ora';

import { toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress } from '../../utils/formatting.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { isQuiet, log, print, printJson, style } from '../../utils/output.js';
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
  validateAddress,
} from '../../utils/trade-input.js';
import { serializeUserOp } from '../../utils/userop-json.js';

type SharedOptions = {
  outcome?: string;
  slippageBps?: string;
  deadlineSec?: string;
  dryRun?: boolean;
  // Commander stores `--no-simulate` as `{ simulate: false }` — the
  // default for a `--no-X` boolean is `true`, so the explicit `false`
  // means the user passed the negative flag.
  simulate?: boolean;
  wait?: boolean;
  waitTimeoutMs?: string;
  waitIntervalMs?: string;
};

type BuyOptions = SharedOptions & { amount: string };
type SellOptions = SharedOptions & { tokens: string };
type CloseOptions = SharedOptions;
type ApproveOptions = {
  amount?: string;
  // Commander stores `--no-X` as `{ x: false }`. See SharedOptions.
  wait?: boolean;
  waitTimeoutMs?: string;
  waitIntervalMs?: string;
  dryRun?: boolean;
  simulate?: boolean;
};

const buyCommand = new Command('buy')
  .description('One-shot BUY: prepare → simulate → sign → submit (and wait by default).')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-a, --amount <usdc>', 'USDC to spend (decimal — e.g. "10" or "12.50")')
  .option('--slippage-bps <n>', 'slippage tolerance in basis points (default 50 = 0.5%)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit; print the UserOp')
  .option('--no-simulate', 'skip the eth_call preflight (faster, riskier)')
  .option('--no-wait', 'fire-and-forget: return userOpHash without waiting for inclusion')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .option('--wait-interval-ms <n>', 'receipt poll interval (default 1500)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol trade buy 0xMarket... -o 0 -a 10
  $ kash protocol trade buy 0xMarket... -o 0 -a 10 --slippage-bps 100   # 1% slippage
  $ kash protocol trade buy 0xMarket... -o 0 -a 10 --dry-run --json
  $ kash protocol trade buy 0xMarket... -o 0 -a 10 --no-wait --json --quiet
`
  )
  .action(async (market: string, options: BuyOptions, cmd: Command) => {
    await runTrade('buy', market, options, cmd);
  });

const sellCommand = new Command('sell')
  .description('One-shot SELL: prepare → simulate → sign → submit (and wait by default).')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-t, --tokens <amount>', 'outcome tokens to sell (decimal — WAD precision)')
  .option('--slippage-bps <n>', 'slippage tolerance in basis points (default 50 = 0.5%)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit; print the UserOp')
  .option('--no-simulate', 'skip the eth_call preflight (faster, riskier)')
  .option('--no-wait', 'fire-and-forget: return userOpHash without waiting for inclusion')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .option('--wait-interval-ms <n>', 'receipt poll interval (default 1500)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol trade sell 0xMarket... -o 0 -t 1.5
  $ kash protocol trade sell 0xMarket... -o 1 -t 0.5 --json --quiet
`
  )
  .action(async (market: string, options: SellOptions, cmd: Command) => {
    await runTrade('sell', market, options, cmd);
  });

const closeCommand = new Command('close')
  .description('Sell the entire SA balance for an outcome (one-shot prepare → submit).')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .option('--slippage-bps <n>', 'slippage tolerance in basis points (default 50 = 0.5%)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit; print the UserOp')
  .option('--no-simulate', 'skip the eth_call preflight (faster, riskier)')
  .option('--no-wait', 'fire-and-forget: return userOpHash without waiting for inclusion')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .option('--wait-interval-ms <n>', 'receipt poll interval (default 1500)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol trade close 0xMarket... -o 0
  $ kash protocol trade close 0xMarket... -o 1 --slippage-bps 200 --json
`
  )
  .action(async (market: string, options: CloseOptions, cmd: Command) => {
    await runTrade('close', market, options, cmd);
  });

const approveCommand = new Command('approve')
  .description('USDC approval — required once before the first BUY.')
  .argument('<spender>', 'spender contract address (typically a Market) — 0x-prefixed')
  .option(
    '-a, --amount <usdc>',
    'atomic-USDC amount to approve (decimal); default is unlimited (MAX_UINT256)'
  )
  .option('--dry-run', 'prepare + simulate but DO NOT sign or submit; print the UserOp')
  .option('--no-simulate', 'skip the eth_call preflight (faster, riskier)')
  .option('--no-wait', 'fire-and-forget: return userOpHash without waiting for inclusion')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .option('--wait-interval-ms <n>', 'receipt poll interval (default 1500)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol trade approve 0xMarket...                     # unlimited approval
  $ kash protocol trade approve 0xMarket... --amount 100        # cap at 100 USDC
  $ kash protocol trade approve 0xMarket... --dry-run --json    # preview only
`
  )
  .action(async (spender: string, options: ApproveOptions, cmd: Command) => {
    await runApprove(spender, options, cmd);
  });

export const tradeCommand = new Command('trade')
  .description('Direct-mode trade execution (UserOp signed locally, submitted via bundler).')
  .addCommand(buyCommand)
  .addCommand(sellCommand)
  .addCommand(closeCommand)
  .addCommand(approveCommand);

// ---------------------------------------------------------------------------
// Shared runners
// ---------------------------------------------------------------------------

type Side = TradeOpSide;

async function runTrade(
  side: Side,
  market: string,
  options: BuyOptions | SellOptions | CloseOptions,
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
  const waitIntervalMs = options.waitIntervalMs
    ? parsePositiveInt(options.waitIntervalMs, 'wait-interval-ms')
    : undefined;

  // Side-specific amount parsing.
  let amountUsdc: bigint | undefined;
  let amountTokens: bigint | undefined;
  if (side === 'buy') {
    const buyOpts = options as BuyOptions;
    amountUsdc = decimalToAtomicUsdc(buyOpts.amount, 'amount');
  } else if (side === 'sell') {
    const sellOpts = options as SellOptions;
    amountTokens = decimalToAtomicWad(sellOpts.tokens, 'tokens');
  }

  try {
    const resolved = await buildDirectClient({ globals, requireSigner: true });

    // --dry-run path: prepare only, emit the populated UserOp + hash.
    // Doesn't sign or submit. Bypasses the wait/submit pipeline.
    if (options.dryRun === true) {
      const built = await prepareForSide(resolved.client, side, {
        market: marketAddress,
        smartAccount: resolved.smartAccount,
        outcome,
        slippageBps,
        ...(deadline === undefined ? {} : { deadline }),
        ...(amountUsdc === undefined ? {} : { amountUsdc }),
        ...(amountTokens === undefined ? {} : { amountTokens }),
        simulate: options.simulate !== false,
      });
      emitDryRun(built, side, market, globals.json);
      return;
    }

    const sendOptions = {
      simulate: options.simulate !== false,
      wait: options.wait !== false,
      ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
      ...(waitIntervalMs === undefined ? {} : { waitIntervalMs }),
    };

    const spinner =
      !globals.json && !isQuiet()
        ? ora({
            text: `Preparing ${side} on ${formatAddress(market, 8, 6)}…`,
            stream: process.stderr,
          }).start()
        : undefined;

    let result;
    try {
      if (side === 'buy') {
        result = await resolved.client.trades.send.buy(
          marketAddress,
          {
            account: resolved.smartAccount,
            outcome,
            amountUsdc: amountUsdc!,
            maxSlippageBps: slippageBps,
            ...(deadline === undefined ? {} : { deadline }),
          },
          sendOptions
        );
      } else if (side === 'sell') {
        result = await resolved.client.trades.send.sell(
          marketAddress,
          {
            account: resolved.smartAccount,
            outcome,
            amountTokens: amountTokens!,
            maxSlippageBps: slippageBps,
            ...(deadline === undefined ? {} : { deadline }),
          },
          sendOptions
        );
      } else {
        result = await resolved.client.trades.send.closePosition(
          marketAddress,
          {
            account: resolved.smartAccount,
            outcome,
            maxSlippageBps: slippageBps,
            ...(deadline === undefined ? {} : { deadline }),
          },
          sendOptions
        );
      }
    } catch (cause) {
      spinner?.fail(`${side} failed.`);
      // Partial-completion guard. If the SDK's submit step succeeded
      // but the wait step timed out, the cause is a KashBundlerError
      // with `code: 'BUNDLER_RECEIPT_TIMEOUT'` whose `context.userOpHash`
      // carries the hash the bundler will eventually land. Surface
      // that hash so the operator can resume via
      // `kash protocol userop wait <hash>` rather than paying for
      // another sign/submit cycle. The discriminator is narrow on
      // purpose — KashSignerError ALSO carries `context.userOpHash`,
      // and a remote-signer failure would be actively misleading if
      // it was reported as "submit succeeded, wait timed out". See
      // `extractPartialUserOpHash` for the discrimination details.
      const partialHash = extractPartialUserOpHash(cause);
      if (partialHash !== undefined) {
        if (globals.json) {
          printJson({ userOpHash: partialHash, waited: false, partial: true });
        } else {
          log.warn(
            `Submit succeeded but wait timed out. UserOp is on the bundler queue — resume with: kash protocol userop wait ${partialHash}`
          );
        }
      }
      throw cause;
    }
    spinner?.succeed(`${side} submitted.`);
    emitSendResult(result, side, market, globals.json);
  } catch (cause) {
    throw toCliError(cause);
  }
}

async function runApprove(spender: string, options: ApproveOptions, cmd: Command): Promise<void> {
  const globals = readGlobals(cmd);
  const spenderAddress = validateAddress(spender, 'spender');
  const amount = options.amount ? decimalToAtomicUsdc(options.amount, 'amount') : MAX_UINT256;
  const waitTimeoutMs = options.waitTimeoutMs
    ? parsePositiveInt(options.waitTimeoutMs, 'wait-timeout-ms')
    : undefined;
  const waitIntervalMs = options.waitIntervalMs
    ? parsePositiveInt(options.waitIntervalMs, 'wait-interval-ms')
    : undefined;

  try {
    const resolved = await buildDirectClient({ globals, requireSigner: true });
    const params = {
      account: resolved.smartAccount,
      spender: spenderAddress,
      amount,
    };

    if (options.dryRun === true) {
      const built = await resolved.client.trades.prepareApprove(params, {
        simulate: options.simulate !== false,
      });
      emitDryRun(built, 'approve', spender, globals.json);
      return;
    }

    const sendOptions = {
      simulate: options.simulate !== false,
      wait: options.wait !== false,
      ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
      ...(waitIntervalMs === undefined ? {} : { waitIntervalMs }),
    };

    const spinner =
      !globals.json && !isQuiet()
        ? ora({
            text: `Approving ${formatAddress(spender, 8, 6)}…`,
            stream: process.stderr,
          }).start()
        : undefined;

    let result;
    try {
      result = await resolved.client.trades.send.approve(params, sendOptions);
    } catch (cause) {
      spinner?.fail('approve failed.');
      // Symmetric partial-completion guard. Approves cost gas; if
      // submit succeeded but wait timed out, surface `userOpHash`
      // so the operator can resume via `kash protocol userop wait
      // <hash>` rather than paying for a duplicate approve. See
      // `extractPartialUserOpHash` for the discrimination rule.
      const partialHash = extractPartialUserOpHash(cause);
      if (partialHash !== undefined) {
        if (globals.json) {
          printJson({ userOpHash: partialHash, waited: false, partial: true });
        } else {
          log.warn(
            `Submit succeeded but wait timed out. The approve UserOp is on the bundler queue — resume with: kash protocol userop wait ${partialHash}`
          );
        }
      }
      throw cause;
    }
    spinner?.succeed('approve submitted.');
    emitSendResult(result, 'approve', spender, globals.json);
  } catch (cause) {
    throw toCliError(cause);
  }
}

// ---------------------------------------------------------------------------
// SDK call adapters
// ---------------------------------------------------------------------------

/**
 * Route prepare to the right SDK method by side. We pass the
 * intersection-typed params and let TypeScript narrow.
 */
async function prepareForSide(
  client: Awaited<ReturnType<typeof buildDirectClient>>['client'],
  side: Side,
  args: {
    market: `0x${string}`;
    /** SA address whose `execute()` will run the trade. Mapped to `account` on the SDK shape. */
    smartAccount: `0x${string}`;
    outcome: number;
    slippageBps: number;
    deadline?: bigint;
    amountUsdc?: bigint;
    amountTokens?: bigint;
    simulate: boolean;
  }
): Promise<Awaited<ReturnType<typeof client.trades.prepareBuy>>> {
  const opts = { simulate: args.simulate };
  // The protocol-sdk's BuildBuy/Sell/ClosePositionParams use
  // `account` (the address that pays USDC and receives outcome
  // tokens). In SA mode, the operator-facing concept is "the smart
  // account" — we keep `smartAccount` as the local name and map at
  // the boundary so the rest of the file reads naturally.
  const baseParams = {
    account: args.smartAccount,
    outcome: args.outcome,
    maxSlippageBps: args.slippageBps,
    ...(args.deadline === undefined ? {} : { deadline: args.deadline }),
  };
  if (side === 'buy') {
    return await client.trades.prepareBuy(
      args.market,
      { ...baseParams, amountUsdc: args.amountUsdc! },
      opts
    );
  }
  if (side === 'sell') {
    return await client.trades.prepareSell(
      args.market,
      { ...baseParams, amountTokens: args.amountTokens! },
      opts
    );
  }
  return await client.trades.prepareClosePosition(args.market, baseParams, opts);
}

// ---------------------------------------------------------------------------
// Output emitters
// ---------------------------------------------------------------------------

type BuiltLike = Awaited<
  ReturnType<Awaited<ReturnType<typeof buildDirectClient>>['client']['trades']['prepareBuy']>
>;

function emitDryRun(built: BuiltLike, side: Side | 'approve', target: string, json: boolean): void {
  // Pre-convert bigints to decimal strings via the shared encoder.
  // `printJson`'s `jsonReplacer` would coerce these on the JSON branch
  // anyway, but the human branch below also reads `userOp.sender` and
  // `userOp.nonce` for the dry-run summary, so we need the converted
  // shape *before* we know which branch we're on. Don't add a third
  // bigint encoder here — `utils/userop-json.ts` is the canonical one.
  const userOp = serializeUserOp(built.userOp);
  if (json) {
    printJson({
      side,
      target,
      userOp,
      userOpHash: built.userOpHash,
      typedData: built.typedData,
      dryRun: true,
    });
    return;
  }
  print('');
  print(`  ${style.bold('Dry run')} — UserOp prepared but NOT signed/submitted.`);
  print(`  ${style.dim('Side    ')} ${side}`);
  print(`  ${style.dim('Target  ')} ${formatAddress(target, 10, 8)}`);
  const senderRaw = userOp['sender'];
  const sender = typeof senderRaw === 'string' ? senderRaw : '';
  print(`  ${style.dim('Sender  ')} ${formatAddress(sender, 10, 8)}`);
  print(`  ${style.dim('Nonce   ')} ${String(userOp['nonce'])}`);
  print(`  ${style.dim('Hash    ')} ${built.userOpHash}`);
  print('');
  print(style.dim('Re-run without --dry-run to sign and submit.'));
}

type SendResultLike =
  | { userOpHash: `0x${string}` }
  | {
      userOpHash: `0x${string}`;
      transactionHash: `0x${string}`;
      blockNumber: bigint;
      success: boolean;
      actualGasUsed: bigint;
    };

function emitSendResult(
  result: SendResultLike,
  side: Side | 'approve',
  target: string,
  json: boolean
): void {
  const waited = 'transactionHash' in result;
  const payload = waited
    ? {
        side,
        target,
        userOpHash: result.userOpHash,
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber.toString(),
        success: result.success,
        actualGasUsed: result.actualGasUsed.toString(),
      }
    : {
        side,
        target,
        userOpHash: result.userOpHash,
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
    print(`  ${style.dim('UserOp   ')} ${result.userOpHash}`);
    print(`  ${style.dim('Tx       ')} ${result.transactionHash}`);
    print(`  ${style.dim('Block    ')} ${result.blockNumber.toString()}`);
    print(`  ${style.dim('Gas used ')} ${result.actualGasUsed.toString()}`);
  } else {
    log.success(`${side} submitted (fire-and-forget).`);
    print(`  ${style.dim('UserOp ')} ${result.userOpHash}`);
    log.info(`Use \`kash protocol userop wait ${result.userOpHash}\` to poll for inclusion.`);
  }
}

/**
 * SA-mode wrapper around the canonical `extractPartialHash` factory
 * (`utils/trade-input.ts`). Pinned to the bundler-timeout code so
 * pre-submit failures (`KashSignerError SIGNER_SIGN_FAILED` carries
 * `context.userOpHash` too) don't masquerade as partial completions.
 *
 * SDK throw site: `protocol-sdk/src/smart-account/bundler/generic.ts:337-341`.
 * Counter-case: `protocol-sdk/src/smart-account/trades/send.ts:222-226`.
 */
function extractPartialUserOpHash(cause: unknown): `0x${string}` | undefined {
  return extractPartialHash(cause, {
    code: 'BUNDLER_RECEIPT_TIMEOUT',
    contextKey: 'userOpHash',
  });
}

// All input parsers live in `utils/trade-input.ts` — single source of
// truth so SA-mode (`kash protocol trade`), userop-build, and EOA-mode
// (`kash eoa trade`) behaviour can never drift on real-money paths.
//
// The UserOp bigint→string encoder lives in `utils/userop-json.ts`;
// the same encoder is used by `userop build / sign / submit`, so a
// `--print-userop` payload round-trips through the offline signer
// pipeline byte-for-byte.
