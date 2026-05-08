/**
 * `kash protocol userop {build,simulate,submit,hash,receipt,wait}` —
 * granular UserOp lifecycle for direct-mode cold-storage flows.
 *
 * Pairs with `kash protocol trade` (the all-in-one path). Use this
 * namespace when you need to:
 *   - Build a UserOp on machine A (no signer; `noopSigner` plumbing).
 *   - Move the UserOp to machine B (signer-only).
 *   - Submit from machine C against the bundler.
 *
 * **File format.** Each command that takes/emits a UserOp uses the
 * canonical JSON shape (bigints serialized as decimal strings).
 * Reading from stdin is supported (`-` argument or no argument);
 * writing goes to stdout (or `--out <path>`).
 *
 * **`build`** uses the SDK's `prepare*` under the hood (build + gas
 * estimation + fees + hash recompute) — the resulting UserOp is fully
 * populated and ready to sign. This matches the cold-storage flow
 * users expect: build once, sign offline, submit later.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { Command } from 'commander';

import { CliError, CliValidationError, toCliError } from '../../errors.js';
import { buildDirectClient } from '../../utils/direct-client.js';
import { formatAddress } from '../../utils/formatting.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';
import {
  DEFAULT_SLIPPAGE_BPS,
  HEX_HASH_REGEX,
  MAX_UINT256,
  decimalToAtomicUsdc,
  decimalToAtomicWad,
  parseDeadlineSec,
  parseOutcomeIndex,
  parseSlippageBps,
  validateAddress,
} from '../../utils/trade-input.js';
import { serializeUserOp } from '../../utils/userop-json.js';

// ---------------------------------------------------------------------------
// `userop build buy|sell|close|approve`
// ---------------------------------------------------------------------------

type BuildSharedOptions = {
  outcome?: string;
  slippageBps?: string;
  deadlineSec?: string;
  out?: string;
  // Commander stores `--no-simulate` as `{ simulate: false }`.
  simulate?: boolean;
};

const buildBuyCommand = new Command('buy')
  .description('Build a fully-populated unsigned BUY UserOp ready for offline signing.')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-a, --amount <usdc>', 'USDC to spend (decimal)')
  .option('--slippage-bps <n>', 'slippage tolerance in bps (default 50 = 0.5%)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--out <path>', 'write the UserOp envelope to a file (default stdout)')
  .option('--no-simulate', 'skip eth_call preflight in `prepare`')
  .action(
    async (market: string, options: BuildSharedOptions & { amount: string }, cmd: Command) => {
      await runBuild('buy', market, options, cmd);
    }
  );

const buildSellCommand = new Command('sell')
  .description('Build a fully-populated unsigned SELL UserOp ready for offline signing.')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .requiredOption('-t, --tokens <amount>', 'outcome tokens to sell (WAD decimal)')
  .option('--slippage-bps <n>', 'slippage tolerance in bps (default 50 = 0.5%)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--out <path>', 'write the UserOp envelope to a file (default stdout)')
  .option('--no-simulate', 'skip eth_call preflight in `prepare`')
  .action(
    async (market: string, options: BuildSharedOptions & { tokens: string }, cmd: Command) => {
      await runBuild('sell', market, options, cmd);
    }
  );

const buildCloseCommand = new Command('close')
  .description('Build a fully-populated unsigned UserOp that closes a position (full balance).')
  .argument('<market>', 'market contract address (0x-prefixed)')
  .requiredOption('-o, --outcome <index>', 'outcome index (0-based)')
  .option('--slippage-bps <n>', 'slippage tolerance in bps (default 50 = 0.5%)')
  .option('--deadline-sec <n>', 'unix-seconds deadline (default now + 5min)')
  .option('--out <path>', 'write the UserOp envelope to a file (default stdout)')
  .option('--no-simulate', 'skip eth_call preflight in `prepare`')
  .action(async (market: string, options: BuildSharedOptions, cmd: Command) => {
    await runBuild('close', market, options, cmd);
  });

const buildApproveCommand = new Command('approve')
  .description('Build a fully-populated unsigned approve UserOp ready for offline signing.')
  .argument('<spender>', 'spender contract address (typically a Market) — 0x-prefixed')
  .option('-a, --amount <usdc>', 'atomic-USDC amount (decimal); default unlimited (MAX_UINT256)')
  .option('--out <path>', 'write the UserOp envelope to a file (default stdout)')
  .option('--no-simulate', 'skip eth_call preflight in `prepare`')
  .action(
    async (
      spender: string,
      options: { amount?: string; out?: string; simulate?: boolean },
      cmd: Command
    ) => {
      await runBuildApprove(spender, options, cmd);
    }
  );

const buildCommand = new Command('build')
  .description('Build (prepare) a fully-populated unsigned UserOp ready for offline signing.')
  .addCommand(buildBuyCommand)
  .addCommand(buildSellCommand)
  .addCommand(buildCloseCommand)
  .addCommand(buildApproveCommand);

type BuildSide = 'buy' | 'sell' | 'close';

async function runBuild(
  side: BuildSide,
  market: string,
  options: BuildSharedOptions & { amount?: string; tokens?: string },
  cmd: Command
): Promise<void> {
  const globals = readGlobals(cmd);
  const marketAddress = validateAddress(market, 'market');
  const outcome = parseOutcomeIndex(options.outcome);
  const slippageBps = options.slippageBps
    ? parseSlippageBps(options.slippageBps)
    : DEFAULT_SLIPPAGE_BPS;
  const deadline = options.deadlineSec ? parseDeadlineSec(options.deadlineSec) : undefined;

  let amountUsdc: bigint | undefined;
  let amountTokens: bigint | undefined;
  if (side === 'buy') {
    amountUsdc = decimalToAtomicUsdc(options.amount!, 'amount');
  } else if (side === 'sell') {
    amountTokens = decimalToAtomicWad(options.tokens!, 'tokens');
  }

  try {
    // `requireSigner: false` because build doesn't need to sign —
    // the noopSigner suffices. The cold-storage flow signs externally.
    const resolved = await buildDirectClient({ globals });
    // The protocol-sdk migrated `smartAccount` → `account` on its
    // BuildBuyParams / BuildSellParams / BuildClosePositionParams
    // shapes. The field still resolves to the same address (the SA
    // we configured); only the parameter name changed. EOA mode also
    // uses `account` (with a different invariant — owner must equal
    // signer.ownerAddress); SA mode is "the SA whose execute() runs."
    const baseParams = {
      account: resolved.smartAccount,
      outcome,
      maxSlippageBps: slippageBps,
      ...(deadline === undefined ? {} : { deadline }),
    };
    const opts = { simulate: options.simulate !== false };

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

    await emitBuildResult(built, side, market, options.out, globals.json);
  } catch (cause) {
    throw toCliError(cause);
  }
}

async function runBuildApprove(
  spender: string,
  options: { amount?: string; out?: string; simulate?: boolean },
  cmd: Command
): Promise<void> {
  const globals = readGlobals(cmd);
  const spenderAddress = validateAddress(spender, 'spender');
  const amount = options.amount ? decimalToAtomicUsdc(options.amount, 'amount') : MAX_UINT256;

  try {
    const resolved = await buildDirectClient({ globals });
    const built = await resolved.client.trades.prepareApprove(
      {
        account: resolved.smartAccount,
        spender: spenderAddress,
        amount,
      },
      { simulate: options.simulate !== false }
    );
    await emitBuildResult(built, 'approve', spender, options.out, globals.json);
  } catch (cause) {
    throw toCliError(cause);
  }
}

// ---------------------------------------------------------------------------
// `userop simulate`
// ---------------------------------------------------------------------------

const simulateCommand = new Command('simulate')
  .description('Simulate (eth_call) an UnsignedUserOp from a file or stdin.')
  .argument('[file]', 'path to a UserOp JSON file (omit or pass "-" for stdin)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol userop build buy 0xMarket... -o 0 -a 10 --out trade.json
  $ kash protocol userop simulate trade.json
  $ cat trade.json | kash protocol userop simulate
`
  )
  .action(async (file: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    try {
      const userOp = await readUnsignedUserOp(file);
      const resolved = await buildDirectClient({ globals });
      const result = await resolved.client.trades.simulate(userOp);

      if (globals.json) {
        printJson(serializeSimulationResult(result));
        return;
      }
      print('');
      if (result.willSucceed) {
        log.success('Simulation: would succeed.');
        if (result.gasEstimate !== undefined) {
          print(`  ${style.dim('Gas estimate ')} ${result.gasEstimate.toString()}`);
        }
      } else {
        log.error('Simulation: would revert.');
        print(`  ${style.dim('Reason   ')} ${result.revertReason}`);
        if (result.decodedError) {
          print(`  ${style.dim('Custom err')} ${result.decodedError.name}`);
        }
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

// ---------------------------------------------------------------------------
// `userop submit`
// ---------------------------------------------------------------------------

type SubmitOptions = {
  skipStalenessCheck?: boolean;
  wait?: boolean;
  waitTimeoutMs?: string;
  waitIntervalMs?: string;
};

const submitCommand = new Command('submit')
  .description('Submit a SignedUserOp from a file or stdin to the configured bundler.')
  .argument('[file]', 'path to a SignedUserOp JSON file (omit or pass "-" for stdin)')
  .option('--skip-staleness-check', 'bypass the EIP-191 staleness check (for typed-data signers)')
  .option('--wait', 'wait for receipt after submitting')
  .option('--wait-timeout-ms <n>', 'cap on the receipt wait (default 60000)')
  .option('--wait-interval-ms <n>', 'receipt poll interval (default 1500)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol userop submit signed.json --json
  $ cat signed.json | kash protocol userop submit --wait
`
  )
  .action(async (file: string | undefined, options: SubmitOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const waitTimeoutMs = options.waitTimeoutMs
      ? parsePositiveInt(options.waitTimeoutMs, 'wait-timeout-ms')
      : undefined;
    const waitIntervalMs = options.waitIntervalMs
      ? parsePositiveInt(options.waitIntervalMs, 'wait-interval-ms')
      : undefined;

    try {
      const signed = await readSignedUserOp(file);
      const resolved = await buildDirectClient({ globals });
      const result = await resolved.client.trades.submit(signed, {
        skipStalenessCheck: options.skipStalenessCheck === true,
      });

      if (options.wait !== true) {
        if (globals.json) {
          printJson({ userOpHash: result.userOpHash, waited: false });
          return;
        }
        log.success('UserOp submitted.');
        print(`  ${style.dim('Hash')} ${result.userOpHash}`);
        log.info(`Use \`kash protocol userop wait ${result.userOpHash}\` to poll for inclusion.`);
        return;
      }

      const waitOpts = {
        ...(waitTimeoutMs === undefined ? {} : { timeoutMs: waitTimeoutMs }),
        ...(waitIntervalMs === undefined ? {} : { intervalMs: waitIntervalMs }),
      };

      // Partial-completion guard. The submit() above succeeded — the
      // UserOp is on the bundler's queue and will eventually land
      // even if our local wait times out. Surface `userOpHash` on
      // BOTH stderr and (for --json) the error envelope before
      // rethrowing, so the operator can resume via
      // `kash protocol userop wait <hash>` instead of paying for
      // another sign/submit cycle. The hash MUST persist before the
      // receipt wait so we never lose track of an in-flight UserOp.
      let receipt: Awaited<ReturnType<typeof resolved.client.bundler.waitForReceipt>>;
      try {
        receipt = await resolved.client.bundler.waitForReceipt(result.userOpHash, waitOpts);
      } catch (waitCause) {
        if (globals.json) {
          // Emit the hash on stdout as a structured partial-success
          // record before letting toCliError build the error envelope.
          // Two NDJSON lines are easier for agents to parse than a
          // merged error+hash blob.
          printJson({ userOpHash: result.userOpHash, waited: false, partial: true });
        } else {
          log.warn(
            `Submit succeeded but wait failed. UserOp is on the bundler queue — resume with: kash protocol userop wait ${result.userOpHash}`
          );
        }
        throw toCliError(waitCause);
      }

      if (globals.json) {
        printJson(serializeReceipt(receipt));
        return;
      }
      emitReceiptHuman(receipt);
    } catch (cause) {
      throw toCliError(cause);
    }
  });

// ---------------------------------------------------------------------------
// `userop hash`
// ---------------------------------------------------------------------------

const hashCommand = new Command('hash')
  .description('Recompute the canonical EIP-4337 v0.7 hash for a UnsignedUserOp.')
  .argument('[file]', 'path to a UserOp JSON file (omit or pass "-" for stdin)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol userop hash trade.json
  $ cat trade.json | kash protocol userop hash --json --quiet | jq -r '.userOpHash'

Notes:
  - The hash baked into a freshly-built UserOp goes stale after gas
    fields are populated. Always recompute via this command (or
    \`hashOf\` in the SDK) before signing.
`
  )
  .action(async (file: string | undefined, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    try {
      const userOp = await readUnsignedUserOp(file);
      const resolved = await buildDirectClient({ globals });
      const userOpHash = resolved.client.trades.hashOf(userOp);

      if (globals.json) {
        printJson({ userOpHash });
        return;
      }
      print(userOpHash);
    } catch (cause) {
      throw toCliError(cause);
    }
  });

// ---------------------------------------------------------------------------
// `userop receipt` / `userop wait`
// ---------------------------------------------------------------------------

const receiptCommand = new Command('receipt')
  .description('Fetch the bundler receipt for a UserOp hash (null if not yet included).')
  .argument('<hash>', 'UserOp hash (0x-prefixed, 32 bytes)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol userop receipt 0xabc...
  $ kash protocol userop receipt 0xabc... --json --quiet | jq -r '.success'
`
  )
  .action(async (hash: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    if (!HEX_HASH_REGEX.test(hash)) {
      throw new CliValidationError(
        '<hash> must be a 0x-prefixed 32-byte hex hash.',
        `Got "${hash}".`,
        'hash'
      );
    }
    try {
      const resolved = await buildDirectClient({ globals });
      const receipt = await resolved.client.bundler.getReceipt(hash as `0x${string}`);

      if (globals.json) {
        printJson(receipt === null ? null : serializeReceipt(receipt));
        return;
      }
      if (receipt === null) {
        log.info('Not yet included (receipt is null).');
        return;
      }
      emitReceiptHuman(receipt);
    } catch (cause) {
      throw toCliError(cause);
    }
  });

const waitCommand = new Command('wait')
  .description('Wait for a UserOp to be included; polls with exponential backoff.')
  .argument('<hash>', 'UserOp hash (0x-prefixed, 32 bytes)')
  .option(
    '--wait-timeout-ms, --timeout-ms <n>',
    'total time budget across polls (default 60000) — distinct from the global --timeout-ms (per-HTTP-request)'
  )
  .option('--interval-ms <n>', 'poll interval (default 1500)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol userop wait 0xabc...
  $ kash protocol userop wait 0xabc... --wait-timeout-ms 300000   # 5min budget
`
  )
  .action(
    async (hash: string, options: { timeoutMs?: string; intervalMs?: string }, cmd: Command) => {
      const globals = readGlobals(cmd);
      if (!HEX_HASH_REGEX.test(hash)) {
        throw new CliValidationError(
          '<hash> must be a 0x-prefixed 32-byte hex hash.',
          `Got "${hash}".`,
          'hash'
        );
      }
      const timeoutMs = options.timeoutMs
        ? parsePositiveInt(options.timeoutMs, 'timeout-ms')
        : undefined;
      const intervalMs = options.intervalMs
        ? parsePositiveInt(options.intervalMs, 'interval-ms')
        : undefined;

      try {
        const resolved = await buildDirectClient({ globals });
        const waitOpts = {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(intervalMs === undefined ? {} : { intervalMs }),
        };
        const receipt = await resolved.client.bundler.waitForReceipt(
          hash as `0x${string}`,
          waitOpts
        );
        if (globals.json) {
          printJson(serializeReceipt(receipt));
          return;
        }
        emitReceiptHuman(receipt);
      } catch (cause) {
        throw toCliError(cause);
      }
    }
  );

// ---------------------------------------------------------------------------
// Top-level userop namespace
// ---------------------------------------------------------------------------

export const useropCommand = new Command('userop')
  .description('Granular UserOp lifecycle: build, simulate, submit, hash, receipt, wait.')
  .addCommand(buildCommand)
  .addCommand(simulateCommand)
  .addCommand(submitCommand)
  .addCommand(hashCommand)
  .addCommand(receiptCommand)
  .addCommand(waitCommand);

// ---------------------------------------------------------------------------
// File IO + serialization
// ---------------------------------------------------------------------------

type UnsignedUserOp = Awaited<
  ReturnType<Awaited<ReturnType<typeof buildDirectClient>>['client']['trades']['prepareBuy']>
>['userOp'];

type SignedUserOp = UnsignedUserOp & { signature: `0x${string}` };

async function emitBuildResult(
  built: { userOp: UnsignedUserOp; userOpHash: `0x${string}`; typedData: unknown },
  side: BuildSide | 'approve',
  target: string,
  outPath: string | undefined,
  json: boolean
): Promise<void> {
  const payload = {
    side,
    target,
    userOp: serializeUserOp(built.userOp),
    userOpHash: built.userOpHash,
    typedData: built.typedData,
  };
  const serialized = JSON.stringify(payload, null, 2);

  if (outPath) {
    try {
      await writeFile(outPath, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (cause) {
      throw new CliError(`Failed to write ${outPath}.`, {
        code: 'CONFIGURATION',
        recoverable: true,
        suggestion: 'Verify the path is writable and the parent directory exists.',
        cause,
      });
    }
    if (!json) {
      log.success(`Wrote ${outPath} (mode 0600).`);
      print(`  ${style.dim('Side  ')} ${side}`);
      print(`  ${style.dim('Target')} ${formatAddress(target, 10, 8)}`);
      print(`  ${style.dim('Hash  ')} ${built.userOpHash}`);
    }
    return;
  }

  if (json) {
    printJson(payload);
    return;
  }
  // Human-mode without --out: emit a compact line + the JSON payload to
  // stderr-vs-stdout split. Keep stdout pure-JSON so it can pipe.
  log.success(`Built ${side} UserOp.`);
  log.detail('Hash', built.userOpHash);
  print(serialized);
}

/** Read a UserOp envelope (from `userop build`) and unpack the inner UserOp. */
async function readUnsignedUserOp(file: string | undefined): Promise<UnsignedUserOp> {
  const raw = await readSource(file);
  const parsed = parseEnvelope(raw);
  return deserializeUserOp(parsed.userOp) as UnsignedUserOp;
}

/**
 * Canonical 65-byte ECDSA signature shape: `0x` + 130 hex chars.
 * Some signers (Ledger, certain custodial flows) emit a longer
 * ERC-1271 / aggregate-style signature, so we accept any 0x-prefixed
 * hex string of even length ≥ 130 — but reject the empty `0x` and
 * sub-65-byte truncations early so the bundler doesn't have to.
 */
const SIGNED_USEROP_SIG_REGEX = /^0x([0-9a-fA-F]{2})+$/;

/** Read a signed UserOp; the signature must already be set. */
async function readSignedUserOp(file: string | undefined): Promise<SignedUserOp> {
  const raw = await readSource(file);
  const parsed = parseEnvelope(raw);
  const userOp = deserializeUserOp(parsed.userOp) as UnsignedUserOp;
  const signature = (userOp as unknown as { signature?: unknown }).signature;
  if (typeof signature !== 'string' || signature === '0x') {
    throw new CliValidationError(
      'UserOp envelope is missing a non-empty `signature` field.',
      'Sign the userOp externally and write the resulting signature into the `userOp.signature` field.'
    );
  }
  // Shape check first (catches typos, accidental truncation, base64
  // signatures that snuck in). Length check second (must be at least
  // a 65-byte ECDSA signature; longer signatures are accepted to
  // support ERC-1271 / aggregate signers).
  if (!SIGNED_USEROP_SIG_REGEX.test(signature)) {
    throw new CliValidationError(
      'UserOp `signature` must be a 0x-prefixed hex string with even-length payload.',
      `Got ${String(signature.length)} characters. Expected at least 132 (0x + 130 hex chars for a 65-byte ECDSA signature).`
    );
  }
  if (signature.length < 132) {
    throw new CliValidationError(
      'UserOp `signature` is too short to be a valid ECDSA signature.',
      `Got ${String(signature.length)} hex chars; canonical ECDSA signatures are 132 (0x + 130). Did the signer truncate output?`
    );
  }
  return userOp as SignedUserOp;
}

async function readSource(file: string | undefined): Promise<string> {
  if (file !== undefined && file !== '-') {
    try {
      return await readFile(file, 'utf8');
    } catch (cause) {
      throw new CliError(`Failed to read ${file}.`, {
        code: 'CONFIGURATION',
        recoverable: true,
        suggestion: 'Verify the path exists and is readable.',
        cause,
      });
    }
  }
  // Stdin.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Buffer) chunks.push(chunk);
    else chunks.push(Buffer.from(chunk as Uint8Array));
  }
  if (chunks.length === 0) {
    throw new CliValidationError(
      'No input received on stdin.',
      'Pass a file path or pipe a UserOp JSON envelope into stdin.'
    );
  }
  // Strip a leading UTF-8 BOM. Required for files exported from
  // Notepad / VSCode-with-utf8bom — JSON.parse chokes on the leading
  // U+FEFF byte otherwise.
  const { stripBom } = await import('../../utils/stdin.js');
  return stripBom(Buffer.concat(chunks).toString('utf8'));
}

function parseEnvelope(raw: string): { userOp: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliValidationError(
      'Input is not valid JSON.',
      'Expected the JSON output of `kash protocol userop build`.'
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { userOp?: unknown }).userOp !== 'object' ||
    (parsed as { userOp?: unknown }).userOp === null
  ) {
    throw new CliValidationError(
      'Input does not contain a `userOp` object.',
      'The envelope must look like { userOp: {...}, userOpHash: "0x…", typedData: {...} }.'
    );
  }
  return parsed as { userOp: Record<string, unknown> };
}

/** Reverse of `serializeUserOp`. Bigint-shaped fields are decoded back. */
function deserializeUserOp(input: Record<string, unknown>): Record<string, unknown> {
  // The bigint-typed fields per UnsignedUserOp's declaration.
  const BIGINT_FIELDS = new Set([
    'nonce',
    'callGasLimit',
    'verificationGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'paymasterVerificationGasLimit',
    'paymasterPostOpGasLimit',
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (BIGINT_FIELDS.has(k) && typeof v === 'string') {
      try {
        out[k] = BigInt(v);
      } catch {
        throw new CliValidationError(
          `UserOp field "${k}" is not a valid bigint string.`,
          `Got ${typeof v === 'string' ? `"${v}"` : String(v)}.`
        );
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

type UserOpReceipt = {
  userOpHash: `0x${string}`;
  sender: `0x${string}`;
  nonce: `0x${string}`;
  success: boolean;
  actualGasCost: `0x${string}`;
  actualGasUsed: `0x${string}`;
  receipt: {
    transactionHash: `0x${string}`;
    blockNumber: `0x${string}`;
    status: `0x${string}`;
  };
};

function serializeReceipt(receipt: UserOpReceipt): Record<string, unknown> {
  return {
    userOpHash: receipt.userOpHash,
    sender: receipt.sender,
    nonce: receipt.nonce,
    success: receipt.success,
    actualGasCost: receipt.actualGasCost,
    actualGasUsed: receipt.actualGasUsed,
    receipt: {
      transactionHash: receipt.receipt.transactionHash,
      blockNumber: receipt.receipt.blockNumber,
      status: receipt.receipt.status,
    },
  };
}

function emitReceiptHuman(receipt: UserOpReceipt): void {
  print('');
  if (receipt.success) {
    log.success('UserOp included successfully.');
  } else {
    log.error('UserOp included but reverted on-chain.');
  }
  print(`  ${style.dim('UserOp ')} ${receipt.userOpHash}`);
  print(`  ${style.dim('Tx     ')} ${receipt.receipt.transactionHash}`);
  print(`  ${style.dim('Block  ')} ${receipt.receipt.blockNumber}`);
  print(`  ${style.dim('Gas    ')} ${receipt.actualGasUsed}`);
}

type SimulationResultLike =
  | { willSucceed: true; gasEstimate?: bigint }
  | {
      willSucceed: false;
      revertReason: string;
      decodedError: { name: string; args: readonly unknown[] } | undefined;
    };

function serializeSimulationResult(result: SimulationResultLike): Record<string, unknown> {
  if (result.willSucceed) {
    return {
      willSucceed: true,
      ...(result.gasEstimate === undefined ? {} : { gasEstimate: result.gasEstimate.toString() }),
    };
  }
  return {
    willSucceed: false,
    revertReason: result.revertReason,
    ...(result.decodedError === undefined
      ? {}
      : {
          decodedError: {
            name: result.decodedError.name,
            args: result.decodedError.args.map((a) => (typeof a === 'bigint' ? a.toString() : a)),
          },
        }),
  };
}

// All input parsers (parseOutcomeIndex, parseSlippageBps,
// parseDeadlineSec, decimalToAtomicUsdc, decimalToAtomicWad,
// validateAddress) live in `utils/trade-input.ts`. Single source of
// truth — userop / trade / eoa modes share the exact same validation
// behaviour, keeping real-money paths in lockstep.
