/**
 * Component tests for `kash protocol trade {buy,sell,close,approve}`.
 *
 * Mocks `buildDirectClient` so we don't spin up viem / a real signer.
 * The mocked SmartAccountClient exposes only the surface the trade
 * command actually uses (`trades.send.*`, `trades.prepare*` for
 * --dry-run). Tests verify:
 *   - SDK call shape (params, options),
 *   - JSON envelope shape (waited vs fire-and-forget),
 *   - --dry-run short-circuits before signing,
 *   - input validators reject malformed args.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

vi.mock('../../src/utils/direct-client.js', () => ({
  buildDirectClient: vi.fn(),
}));

const { buildDirectClient } = await import('../../src/utils/direct-client.js');
const { tradeCommand } = await import('../../src/commands/protocol/trade.js');
const buildDirectClientMock = vi.mocked(buildDirectClient);

const MARKET = '0x1234567890abcdef1234567890abcdef12345678';
const SA = '0xfedcba0987654321fedcba0987654321fedcba09';
const TX_HASH = `0x${'a'.repeat(64)}`;
const USER_OP_HASH = `0x${'b'.repeat(64)}`;

/** Build a stub SmartAccountClient with mockable `trades.send.*` and `trades.prepare*`. */
function makeStubClient(): {
  trades: {
    send: {
      buy: ReturnType<typeof vi.fn>;
      sell: ReturnType<typeof vi.fn>;
      closePosition: ReturnType<typeof vi.fn>;
      approve: ReturnType<typeof vi.fn>;
    };
    prepareBuy: ReturnType<typeof vi.fn>;
    prepareSell: ReturnType<typeof vi.fn>;
    prepareClosePosition: ReturnType<typeof vi.fn>;
    prepareApprove: ReturnType<typeof vi.fn>;
  };
} {
  return {
    trades: {
      send: {
        buy: vi.fn(),
        sell: vi.fn(),
        closePosition: vi.fn(),
        approve: vi.fn(),
      },
      prepareBuy: vi.fn(),
      prepareSell: vi.fn(),
      prepareClosePosition: vi.fn(),
      prepareApprove: vi.fn(),
    },
  };
}

function waitedResult(): {
  userOpHash: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  success: boolean;
  gasUsed: bigint;
} {
  return {
    userOpHash: USER_OP_HASH as `0x${string}`,
    transactionHash: TX_HASH as `0x${string}`,
    blockNumber: 12_345n,
    success: true,
    // SDK shape — see protocol-sdk's SendResultWaited. CLI emitSendResult
    // reads `gasUsed` and emits the bundler-receipt-canonical
    // `actualGasUsed` JSON key (asserted below).
    gasUsed: 250_000n,
  };
}

function fireAndForgetResult(): { userOpHash: `0x${string}` } {
  return { userOpHash: USER_OP_HASH as `0x${string}` };
}

function builtUserOp(): {
  userOp: { sender: `0x${string}`; nonce: bigint; callGasLimit: bigint };
  userOpHash: `0x${string}`;
  typedData: { primaryType: string };
} {
  return {
    userOp: {
      sender: SA as `0x${string}`,
      nonce: 0n,
      callGasLimit: 100_000n,
    },
    userOpHash: USER_OP_HASH as `0x${string}`,
    typedData: { primaryType: 'PackedUserOperation' },
  };
}

describe('kash protocol trade buy', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });

  afterEach(() => teardown());

  it('forwards params + emits waited JSON envelope on success', async () => {
    const client = makeStubClient();
    client.trades.send.buy.mockResolvedValue(waitedResult());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(program, leafName, ['buy', MARKET, '-o', '0', '-a', '10'], ['--json']);

    // Mock should have been called with `requireSigner: true`.
    expect(buildDirectClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ requireSigner: true })
    );

    // SDK params: outcome 0, USDC atomic = 10_000_000, default slippage 50bps.
    expect(client.trades.send.buy).toHaveBeenCalledWith(
      MARKET,
      expect.objectContaining({
        account: SA,
        outcome: 0,
        amountUsdc: 10_000_000n,
        maxSlippageBps: 50,
      }),
      expect.objectContaining({ simulate: true, wait: true })
    );

    const json = parseJsonStdout(capture) as {
      side: string;
      transactionHash: string;
      blockNumber: string;
      success: boolean;
      actualGasUsed: string;
    };
    expect(json.side).toBe('buy');
    expect(json.transactionHash).toBe(TX_HASH);
    expect(json.blockNumber).toBe('12345'); // bigint serialized as decimal string
    expect(json.success).toBe(true);
    expect(json.actualGasUsed).toBe('250000');
  });

  it('--dry-run never calls send.* and emits the populated UserOp envelope', async () => {
    const client = makeStubClient();
    client.trades.prepareBuy.mockResolvedValue(builtUserOp());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(
      program,
      leafName,
      ['buy', MARKET, '-o', '0', '-a', '10', '--dry-run'],
      ['--json']
    );

    expect(client.trades.send.buy).not.toHaveBeenCalled();
    expect(client.trades.prepareBuy).toHaveBeenCalledTimes(1);

    const json = parseJsonStdout(capture) as {
      side: string;
      dryRun: boolean;
      userOpHash: string;
      userOp: { sender: string; nonce: string };
    };
    expect(json.side).toBe('buy');
    expect(json.dryRun).toBe(true);
    expect(json.userOpHash).toBe(USER_OP_HASH);
    expect(json.userOp.nonce).toBe('0'); // bigint stringified
  });

  it('--no-wait emits a fire-and-forget envelope', async () => {
    const client = makeStubClient();
    client.trades.send.buy.mockResolvedValue(fireAndForgetResult());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(
      program,
      leafName,
      ['buy', MARKET, '-o', '0', '-a', '10', '--no-wait'],
      ['--json']
    );

    expect(client.trades.send.buy).toHaveBeenCalledWith(
      MARKET,
      expect.any(Object),
      expect.objectContaining({ wait: false })
    );

    const json = parseJsonStdout(capture) as { userOpHash: string; waited: boolean };
    expect(json.userOpHash).toBe(USER_OP_HASH);
    expect(json.waited).toBe(false);
  });

  it('honours --slippage-bps and --deadline-sec', async () => {
    const client = makeStubClient();
    client.trades.send.buy.mockResolvedValue(waitedResult());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(program, leafName, [
      'buy',
      MARKET,
      '-o',
      '0',
      '-a',
      '10',
      '--slippage-bps',
      '200',
      '--deadline-sec',
      '1900000000',
    ]);

    expect(client.trades.send.buy).toHaveBeenCalledWith(
      MARKET,
      expect.objectContaining({
        maxSlippageBps: 200,
        deadline: 1_900_000_000n,
      }),
      expect.any(Object)
    );
  });

  it('rejects malformed market address with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['buy', 'not-an-address', '-o', '0', '-a', '10'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(buildDirectClientMock).not.toHaveBeenCalled();
  });

  it('rejects out-of-range outcome', async () => {
    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['buy', MARKET, '-o', '99', '-a', '10'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects out-of-range slippage-bps (> 10000)', async () => {
    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, [
        'buy',
        MARKET,
        '-o',
        '0',
        '-a',
        '10',
        '--slippage-bps',
        '20000',
      ])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects malformed --amount (too many fractional digits)', async () => {
    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['buy', MARKET, '-o', '0', '-a', '10.1234567'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('kash protocol trade buy — partial-completion guard', () => {
  // The SDK's `trades.send.buy` performs submit + (optional) wait
  // internally. When the wait phase times out, it re-throws a
  // KashBundlerError with `code: 'BUNDLER_RECEIPT_TIMEOUT'` and
  // `context.userOpHash`. The CLI catches that exact shape and
  // surfaces the hash so operators can resume via
  // `kash protocol userop wait <hash>` instead of paying for another
  // sign/submit cycle. KashSignerError ALSO carries
  // `context.userOpHash` (signer rejected before submit), so we pin
  // that the discriminator is narrow enough to NOT misreport that
  // case as a partial completion.

  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });

  afterEach(() => teardown());

  it('surfaces userOpHash on JSON branch when wait phase times out', async () => {
    const client = makeStubClient();
    // Mimic the SDK's `KashBundlerError` shape on receipt timeout.
    const bundlerTimeout = Object.assign(new Error('timed out waiting for UserOp'), {
      name: 'KashBundlerError',
      code: 'BUNDLER_RECEIPT_TIMEOUT',
      context: { userOpHash: USER_OP_HASH, timeoutMs: 60_000 },
    });
    client.trades.send.buy.mockRejectedValue(bundlerTimeout);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['buy', MARKET, '-o', '0', '-a', '10'], ['--json'])
    ).rejects.toBeDefined();

    // The CLI emits the partial-completion record on stdout BEFORE
    // rethrowing. Pretty-printed JSON in --json mode (multi-line),
    // so parse the whole capture.
    const partial = parseJsonStdout(capture) as {
      userOpHash: string;
      waited: boolean;
      partial: boolean;
    };
    expect(partial.userOpHash).toBe(USER_OP_HASH);
    expect(partial.waited).toBe(false);
    expect(partial.partial).toBe(true);
  });

  it('surfaces resume-command on stderr when wait times out (human mode)', async () => {
    const client = makeStubClient();
    const bundlerTimeout = Object.assign(new Error('timed out waiting for UserOp'), {
      name: 'KashBundlerError',
      code: 'BUNDLER_RECEIPT_TIMEOUT',
      context: { userOpHash: USER_OP_HASH, timeoutMs: 60_000 },
    });
    client.trades.send.buy.mockRejectedValue(bundlerTimeout);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['buy', MARKET, '-o', '0', '-a', '10'])
    ).rejects.toBeDefined();

    expect(capture.stderr).toContain(USER_OP_HASH);
    expect(capture.stderr).toContain('kash protocol userop wait');
  });

  it('does NOT emit a partial record on signer failure (KashSignerError carries userOpHash too)', async () => {
    const client = makeStubClient();
    // Mimic the SDK's `KashSignerError` shape — same `context.userOpHash`,
    // different code. The CLI must NOT report this as a partial completion
    // because nothing was submitted to the bundler.
    const signerFailure = Object.assign(new Error('signer.signUserOpHash failed'), {
      name: 'KashSignerError',
      code: 'SIGNER_SIGN_FAILED',
      context: { ownerAddress: SA, userOpHash: USER_OP_HASH },
    });
    client.trades.send.buy.mockRejectedValue(signerFailure);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['buy', MARKET, '-o', '0', '-a', '10'], ['--json'])
    ).rejects.toBeDefined();

    // No partial-completion record on stdout, no resume hint on stderr.
    expect(capture.stdout.trim()).toBe('');
    expect(capture.stderr).not.toContain('kash protocol userop wait');
  });

  it('does NOT emit a partial record on a generic submit failure (no userOpHash in context)', async () => {
    const client = makeStubClient();
    // Generic Error — no `code`, no `context`. The discriminator must
    // refuse to fabricate a partial-completion claim.
    client.trades.send.buy.mockRejectedValue(new Error('something exploded pre-submit'));
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['buy', MARKET, '-o', '0', '-a', '10'], ['--json'])
    ).rejects.toBeDefined();

    expect(capture.stdout.trim()).toBe('');
    expect(capture.stderr).not.toContain('kash protocol userop wait');
  });
});

describe('kash protocol trade sell', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('converts --tokens decimal to WAD-18 atomic input', async () => {
    const client = makeStubClient();
    client.trades.send.sell.mockResolvedValue(waitedResult());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(program, leafName, ['sell', MARKET, '-o', '1', '-t', '1.5']);

    expect(client.trades.send.sell).toHaveBeenCalledWith(
      MARKET,
      expect.objectContaining({
        outcome: 1,
        // 1.5 in WAD-18 = 1_500_000_000_000_000_000n
        amountTokens: 1_500_000_000_000_000_000n,
      }),
      expect.any(Object)
    );
  });
});

describe('kash protocol trade close', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('routes through closePosition without amount params', async () => {
    const client = makeStubClient();
    client.trades.send.closePosition.mockResolvedValue(waitedResult());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(program, leafName, ['close', MARKET, '-o', '0']);

    const call = client.trades.send.closePosition.mock.calls[0]!;
    const params = call[1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('amountUsdc');
    expect(params).not.toHaveProperty('amountTokens');
    expect(params['outcome']).toBe(0);
  });
});

describe('kash protocol trade approve', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('defaults to MAX_UINT256 when --amount is omitted', async () => {
    const client = makeStubClient();
    client.trades.send.approve.mockResolvedValue(waitedResult());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(program, leafName, ['approve', MARKET]);

    const MAX_UINT256 = 2n ** 256n - 1n;
    expect(client.trades.send.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        spender: MARKET,
        account: SA,
        amount: MAX_UINT256,
      }),
      expect.any(Object)
    );
  });

  it('honours an explicit --amount cap', async () => {
    const client = makeStubClient();
    client.trades.send.approve.mockResolvedValue(waitedResult());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(program, leafName, ['approve', MARKET, '--amount', '100']);

    expect(client.trades.send.approve).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100_000_000n }),
      expect.any(Object)
    );
  });

  it('--dry-run uses prepareApprove and skips send.approve', async () => {
    const client = makeStubClient();
    client.trades.prepareApprove.mockResolvedValue(builtUserOp());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await runViaProgram(program, leafName, ['approve', MARKET, '--dry-run'], ['--json']);

    expect(client.trades.send.approve).not.toHaveBeenCalled();
    expect(client.trades.prepareApprove).toHaveBeenCalledTimes(1);

    const json = parseJsonStdout(capture) as { side: string; dryRun: boolean };
    expect(json.side).toBe('approve');
    expect(json.dryRun).toBe(true);
  });

  // Symmetric to the buy/sell partial-completion tests. Approves
  // cost gas; if submit succeeded but wait timed out, the operator
  // must be able to resume rather than pay for a duplicate approve.
  it('surfaces userOpHash partial record when wait phase times out', async () => {
    const client = makeStubClient();
    const bundlerTimeout = Object.assign(new Error('timed out waiting for UserOp'), {
      name: 'KashBundlerError',
      code: 'BUNDLER_RECEIPT_TIMEOUT',
      context: { userOpHash: USER_OP_HASH, timeoutMs: 60_000 },
    });
    client.trades.send.approve.mockRejectedValue(bundlerTimeout);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['approve', MARKET], ['--json'])
    ).rejects.toBeDefined();

    const partial = parseJsonStdout(capture) as {
      userOpHash: string;
      waited: boolean;
      partial: boolean;
    };
    expect(partial.userOpHash).toBe(USER_OP_HASH);
    expect(partial.partial).toBe(true);
  });

  it('does NOT emit a partial record on signer failure during approve', async () => {
    const client = makeStubClient();
    const signerFailure = Object.assign(new Error('signer.signUserOpHash failed'), {
      name: 'KashSignerError',
      code: 'SIGNER_SIGN_FAILED',
      context: { ownerAddress: SA, userOpHash: USER_OP_HASH },
    });
    client.trades.send.approve.mockRejectedValue(signerFailure);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(tradeCommand);
    await expect(
      runViaProgram(program, leafName, ['approve', MARKET], ['--json'])
    ).rejects.toBeDefined();

    expect(capture.stdout.trim()).toBe('');
    expect(capture.stderr).not.toContain('kash protocol userop wait');
  });
});
