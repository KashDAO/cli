/**
 * Component tests for `kash eoa …`.
 *
 * Mocks `buildEoaClient` (the EOA-mode parallel of `buildDirectClient`).
 * Verifies the read commands' SDK call shape, the trade execution
 * commands' params + envelope, and the input validators.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

vi.mock('../../src/utils/eoa-client.js', () => ({
  buildEoaClient: vi.fn(),
}));

const { buildEoaClient } = await import('../../src/utils/eoa-client.js');
const { eoaCommand } = await import('../../src/commands/eoa/index.js');
const buildEoaClientMock = vi.mocked(buildEoaClient);

const MARKET = '0x1234567890abcdef1234567890abcdef12345678';
const EOA = '0xfedcba0987654321fedcba0987654321fedcba09';
const TX_HASH = `0x${'a'.repeat(64)}` as const;

function makeStubClient(): {
  markets: {
    state: ReturnType<typeof vi.fn>;
    quote: ReturnType<typeof vi.fn>;
  };
  account: {
    usdcBalance: ReturnType<typeof vi.fn>;
    gasBalance: ReturnType<typeof vi.fn>;
    position: ReturnType<typeof vi.fn>;
    usdcAllowance: ReturnType<typeof vi.fn>;
  };
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
  estimateFees: ReturnType<typeof vi.fn>;
} {
  return {
    markets: {
      state: vi.fn(),
      quote: vi.fn(),
    },
    account: {
      usdcBalance: vi.fn(),
      gasBalance: vi.fn(),
      position: vi.fn(),
      usdcAllowance: vi.fn(),
    },
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
    estimateFees: vi.fn(),
  };
}

function waitedTxResult(): {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  success: boolean;
  gasUsed: bigint;
} {
  return {
    transactionHash: TX_HASH,
    blockNumber: 12_345n,
    success: true,
    gasUsed: 200_000n,
  };
}

function builtTx(): {
  transaction: { to: `0x${string}`; nonce: bigint; gas: bigint };
  transactionHash: `0x${string}`;
} {
  return {
    transaction: {
      to: MARKET as `0x${string}`,
      nonce: 0n,
      gas: 300_000n,
    },
    transactionHash: TX_HASH,
  };
}

describe('kash eoa balance', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildEoaClientMock.mockReset();
  });
  afterEach(() => teardown());

  it("defaults the account to the signer's ownerAddress", async () => {
    const client = makeStubClient();
    client.account.usdcBalance.mockResolvedValue(1_000_000n);
    client.account.gasBalance.mockResolvedValue(5_000_000_000_000_000n);
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await runViaProgram(program, leafName, ['balance'], ['--json']);

    expect(client.account.usdcBalance).toHaveBeenCalledWith(EOA);
    expect(client.account.gasBalance).toHaveBeenCalledWith(EOA);
    const json = parseJsonStdout(capture) as { account: string; usdcAtomic: string };
    expect(json.account).toBe(EOA);
    expect(json.usdcAtomic).toBe('1000000');
  });

  it('honours an explicit account argument', async () => {
    const client = makeStubClient();
    client.account.usdcBalance.mockResolvedValue(0n);
    client.account.gasBalance.mockResolvedValue(0n);
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const other = '0xaaaabbbbccccdddd0000111122223333aaaabbbb';
    const { program, leafName } = wrapInProgram(eoaCommand);
    await runViaProgram(program, leafName, ['balance', other]);

    expect(client.account.usdcBalance).toHaveBeenCalledWith(other);
  });

  it('rejects malformed account address with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['balance', 'not-an-address'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('kash eoa quote', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildEoaClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('forwards { side, outcome, amount } as bigint atomic units', async () => {
    const client = makeStubClient();
    client.markets.quote.mockResolvedValue({
      side: 'BUY',
      outcomeIndex: 0,
      amountIn: 10_000_000n,
      amountOut: 15_000_000_000_000_000_000n,
      reserveAfterWad: 500_000_000_000_000_000_000n,
      pricesAfterWad: [620_000_000_000_000_000n, 380_000_000_000_000_000n],
    });
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await runViaProgram(
      program,
      leafName,
      ['quote', MARKET, '-s', 'buy', '-o', '0', '-a', '10'],
      ['--json']
    );

    expect(client.markets.quote).toHaveBeenCalledWith(MARKET, {
      side: 'BUY',
      outcome: 0,
      amount: 10_000_000n, // 10 USDC → atomic-6
    });
  });

  it('rejects unknown --side', async () => {
    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['quote', MARKET, '-s', 'lend', '-o', '0', '-a', '10'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('kash eoa trade buy', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildEoaClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('routes through trades.send.buy with default simulate + wait', async () => {
    const client = makeStubClient();
    client.trades.send.buy.mockResolvedValue(waitedTxResult());
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await runViaProgram(
      program,
      leafName,
      ['trade', 'buy', MARKET, '-o', '0', '-a', '10'],
      ['--json']
    );

    // **Field-aliasing pin.** The SDK's `BuildBuyParams` shape names
    // its account-hint field `smartAccount` even in EOA mode (history:
    // SA mode came first). The CLI populates it with the EOA address
    // here. If the SDK ever splits these into a discriminated union
    // and tightens the SA-only field, this assertion fails — that's
    // the canary that lets us update the CLI without silently
    // mis-trading. Don't soften this expectation without re-reading
    // protocol-sdk's eoa/trades/build.ts.
    expect(client.trades.send.buy).toHaveBeenCalledWith(
      MARKET,
      expect.objectContaining({
        account: EOA,
        smartAccount: EOA,
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
    };
    expect(json.side).toBe('buy');
    expect(json.transactionHash).toBe(TX_HASH);
    expect(json.blockNumber).toBe('12345');
    expect(json.success).toBe(true);
  });

  it('--dry-run uses prepareBuy and skips trades.send.buy', async () => {
    const client = makeStubClient();
    client.trades.prepareBuy.mockResolvedValue(builtTx());
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await runViaProgram(
      program,
      leafName,
      ['trade', 'buy', MARKET, '-o', '0', '-a', '10', '--dry-run'],
      ['--json']
    );

    expect(client.trades.send.buy).not.toHaveBeenCalled();
    expect(client.trades.prepareBuy).toHaveBeenCalledTimes(1);

    const json = parseJsonStdout(capture) as {
      side: string;
      dryRun: boolean;
      transactionHash: string;
    };
    expect(json.side).toBe('buy');
    expect(json.dryRun).toBe(true);
    expect(json.transactionHash).toBe(TX_HASH);
  });

  it('--no-wait emits a fire-and-forget envelope', async () => {
    const client = makeStubClient();
    client.trades.send.buy.mockResolvedValue({ transactionHash: TX_HASH });
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await runViaProgram(
      program,
      leafName,
      ['trade', 'buy', MARKET, '-o', '0', '-a', '10', '--no-wait'],
      ['--json']
    );

    expect(client.trades.send.buy).toHaveBeenCalledWith(
      MARKET,
      expect.any(Object),
      expect.objectContaining({ wait: false })
    );

    const json = parseJsonStdout(capture) as { transactionHash: string; waited: boolean };
    expect(json.transactionHash).toBe(TX_HASH);
    expect(json.waited).toBe(false);
  });
});

describe('kash eoa trade buy — partial-completion guard', () => {
  // Symmetric to the SA-mode partial-completion guard. When the EOA
  // SDK's `trades.send.buy` succeeds at submit but the wait phase
  // times out, it throws KashChainError with `code: 'WAIT_RECEIPT_FAILED'`
  // and `context.transactionHash`. The CLI surfaces that hash so the
  // operator can check inclusion via a block explorer instead of
  // losing the pointer for a tx they already paid gas for.

  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildEoaClientMock.mockReset();
  });

  afterEach(() => teardown());

  it('surfaces transactionHash on JSON branch when wait phase times out', async () => {
    const client = makeStubClient();
    const waitFailed = Object.assign(new Error('timed out waiting for tx'), {
      name: 'KashChainError',
      code: 'WAIT_RECEIPT_FAILED',
      context: { transactionHash: TX_HASH, chainId: 8453 },
    });
    client.trades.send.buy.mockRejectedValue(waitFailed);
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['trade', 'buy', MARKET, '-o', '0', '-a', '10'], ['--json'])
    ).rejects.toBeDefined();

    const partial = parseJsonStdout(capture) as {
      transactionHash: string;
      waited: boolean;
      partial: boolean;
    };
    expect(partial.transactionHash).toBe(TX_HASH);
    expect(partial.waited).toBe(false);
    expect(partial.partial).toBe(true);
  });

  it('surfaces explorer-check hint on stderr when wait times out (human mode)', async () => {
    const client = makeStubClient();
    const waitFailed = Object.assign(new Error('timed out waiting for tx'), {
      name: 'KashChainError',
      code: 'WAIT_RECEIPT_FAILED',
      context: { transactionHash: TX_HASH, chainId: 8453 },
    });
    client.trades.send.buy.mockRejectedValue(waitFailed);
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['trade', 'buy', MARKET, '-o', '0', '-a', '10'])
    ).rejects.toBeDefined();

    expect(capture.stderr).toContain(TX_HASH);
    expect(capture.stderr).toContain('block explorer');
  });

  it('does NOT emit a partial record on unrelated KashChainError (e.g. CHAIN_RPC_FAILED)', async () => {
    const client = makeStubClient();
    // Same error class, different code — no `transactionHash` because
    // submit never happened. The discriminator must reject this case
    // so the operator isn't told a tx is on-chain when none is.
    const rpcFailure = Object.assign(new Error('rpc returned 502'), {
      name: 'KashChainError',
      code: 'CHAIN_RPC_FAILED',
      context: { chainId: 8453 },
    });
    client.trades.send.buy.mockRejectedValue(rpcFailure);
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['trade', 'buy', MARKET, '-o', '0', '-a', '10'], ['--json'])
    ).rejects.toBeDefined();

    expect(capture.stdout.trim()).toBe('');
    expect(capture.stderr).not.toContain('block explorer');
  });

  it('does NOT emit a partial record on a generic submit failure', async () => {
    const client = makeStubClient();
    client.trades.send.buy.mockRejectedValue(new Error('something exploded pre-submit'));
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['trade', 'buy', MARKET, '-o', '0', '-a', '10'], ['--json'])
    ).rejects.toBeDefined();

    expect(capture.stdout.trim()).toBe('');
    expect(capture.stderr).not.toContain('block explorer');
  });
});

describe('kash eoa trade approve', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildEoaClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('defaults to MAX_UINT256 when --amount is omitted', async () => {
    const client = makeStubClient();
    client.trades.send.approve.mockResolvedValue(waitedTxResult());
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await runViaProgram(program, leafName, ['trade', 'approve', MARKET]);

    const MAX_UINT256 = 2n ** 256n - 1n;
    expect(client.trades.send.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        spender: MARKET,
        account: EOA,
        amount: MAX_UINT256,
      }),
      expect.any(Object)
    );
  });

  // Symmetric to `kash eoa trade buy` partial-completion tests.
  // The EOA SDK's `sendApproveTransaction` shares the same dispatch
  // function as buy/sell/close, so it throws the identical
  // KashChainError(WAIT_RECEIPT_FAILED) shape on post-submit wait
  // timeout. Approves cost gas — losing the tx hash here means the
  // operator may pay gas for a duplicate.
  it('surfaces transactionHash partial record when wait phase times out', async () => {
    const client = makeStubClient();
    const waitFailed = Object.assign(new Error('timed out waiting for tx'), {
      name: 'KashChainError',
      code: 'WAIT_RECEIPT_FAILED',
      context: { transactionHash: TX_HASH, chainId: 8453 },
    });
    client.trades.send.approve.mockRejectedValue(waitFailed);
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['trade', 'approve', MARKET], ['--json'])
    ).rejects.toBeDefined();

    const partial = parseJsonStdout(capture) as {
      transactionHash: string;
      waited: boolean;
      partial: boolean;
    };
    expect(partial.transactionHash).toBe(TX_HASH);
    expect(partial.partial).toBe(true);
  });

  it('does NOT emit a partial record on unrelated KashChainError during approve', async () => {
    const client = makeStubClient();
    const rpcFailure = Object.assign(new Error('rpc returned 502'), {
      name: 'KashChainError',
      code: 'CHAIN_RPC_FAILED',
      context: { chainId: 8453 },
    });
    client.trades.send.approve.mockRejectedValue(rpcFailure);
    buildEoaClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      account: EOA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(eoaCommand);
    await expect(
      runViaProgram(program, leafName, ['trade', 'approve', MARKET], ['--json'])
    ).rejects.toBeDefined();

    expect(capture.stdout.trim()).toBe('');
    expect(capture.stderr).not.toContain('block explorer');
  });
});
