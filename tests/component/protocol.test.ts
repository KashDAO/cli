/**
 * Component tests for `kash protocol balance/market/quote`.
 *
 * These commands route through `buildDirectClient` which dynamically
 * imports `@kashdao/protocol-sdk` + viem. We mock the wrapper at the
 * `utils/direct-client.ts` boundary so tests never spin up a real
 * viem `PublicClient` (no network, no RPC, no chain assumptions).
 *
 * Coverage focus:
 *   - Argument validation (hex addresses, side casing, amount units).
 *   - SDK call shape (right method, right args, right unit conversion).
 *   - JSON output stability (bigints stringified, no undefineds leaking).
 *   - Error mapping (protocol-sdk error names → CLI codes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

vi.mock('../../src/utils/direct-client.js', () => ({
  buildDirectClient: vi.fn(),
}));

const { buildDirectClient } = await import('../../src/utils/direct-client.js');
const { balanceCommand } = await import('../../src/commands/protocol/balance.js');
const { marketCommand } = await import('../../src/commands/protocol/market.js');
const { quoteCommand } = await import('../../src/commands/protocol/quote.js');

const buildDirectClientMock = vi.mocked(buildDirectClient);

const SMART_ACCOUNT = '0x1111111111111111111111111111111111111111';
const MARKET_ADDRESS = '0x2222222222222222222222222222222222222222';

/** Build a stub DirectClient with each method resolved/rejected as configured. */
function stubDirectClient(overrides: {
  readonly usdcBalance?: bigint;
  readonly gasBalance?: bigint;
  readonly state?: object;
  readonly quote?: object;
  readonly throwOn?: 'usdc' | 'state' | 'quote';
}) {
  const usdc = vi.fn().mockResolvedValue(overrides.usdcBalance ?? 0n);
  const gas = vi.fn().mockResolvedValue(overrides.gasBalance ?? 0n);
  const stateFn = vi.fn().mockResolvedValue(overrides.state ?? {});
  const quoteFn = vi.fn().mockResolvedValue(overrides.quote ?? {});

  if (overrides.throwOn === 'usdc') {
    const err = new Error('chain error');
    err.name = 'KashChainError';
    usdc.mockRejectedValueOnce(err);
  }
  if (overrides.throwOn === 'state') {
    const err = new Error('chain error');
    err.name = 'KashChainError';
    stateFn.mockRejectedValueOnce(err);
  }
  if (overrides.throwOn === 'quote') {
    const err = new Error('reverted');
    err.name = 'KashSimulationRevertedError';
    quoteFn.mockRejectedValueOnce(err);
  }

  return {
    chainId: 8453,
    smartAccount: SMART_ACCOUNT,
    client: {
      account: { usdcBalance: usdc, gasBalance: gas },
      markets: { state: stateFn, quote: quoteFn },
      // The other DirectClient surfaces aren't used by these
      // read-only commands; leave them untyped so the harness
      // stays minimal.
    } as never,
  };
}

describe('kash protocol balance', () => {
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

  it("defaults to the active profile's smartAccount when no argument is given", async () => {
    const stub = stubDirectClient({
      usdcBalance: 1_000_000n, // $1
      gasBalance: 1_000_000_000_000_000n, // 0.001 ETH
    });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(balanceCommand);
    await runViaProgram(program, leafName, []);

    expect(stub.client.account.usdcBalance).toHaveBeenCalledWith(SMART_ACCOUNT);
    expect(capture.stdout).toContain('$1.00');
  });

  it('accepts an explicit account argument', async () => {
    const otherAccount = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const stub = stubDirectClient({ usdcBalance: 0n, gasBalance: 0n });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(balanceCommand);
    await runViaProgram(program, leafName, [otherAccount]);

    expect(stub.client.account.usdcBalance).toHaveBeenCalledWith(otherAccount);
  });

  it('rejects a malformed account address with INVALID_INPUT', async () => {
    const stub = stubDirectClient({});
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(balanceCommand);
    await expect(runViaProgram(program, leafName, ['not-an-address'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('emits structured JSON with bigints as strings', async () => {
    const stub = stubDirectClient({
      usdcBalance: 12_500_000n,
      gasBalance: 5_000_000_000_000_000n,
    });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(balanceCommand);
    await runViaProgram(program, leafName, [], ['--json', '--quiet']);

    const json = parseJsonStdout(capture) as {
      account: string;
      chainId: number;
      usdcAtomic: string;
      gasWei: string;
    };
    expect(json.account).toBe(SMART_ACCOUNT);
    expect(json.chainId).toBe(8453);
    expect(json.usdcAtomic).toBe('12500000');
    expect(json.gasWei).toBe('5000000000000000');
  });

  it('maps a KashChainError from the protocol-sdk to CHAIN_ERROR', async () => {
    const stub = stubDirectClient({ throwOn: 'usdc' });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(balanceCommand);
    await expect(runViaProgram(program, leafName, [])).rejects.toMatchObject({
      code: 'CHAIN_ERROR',
    });
  });
});

describe('kash protocol market', () => {
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

  it('emits the market state with bigints serialised as strings', async () => {
    const stub = stubDirectClient({
      state: {
        marketAddress: MARKET_ADDRESS,
        status: 'active',
        readAt: 123n,
        reserveWad: 1_000_000_000_000_000_000_000n, // 1000 USDC
        outcomes: [
          {
            index: 0,
            outstandingTokensWad: 500_000_000_000_000_000_000n,
            weightWad: 500_000_000_000_000_000n,
            probability: 0.5,
          },
          {
            index: 1,
            outstandingTokensWad: 500_000_000_000_000_000_000n,
            weightWad: 500_000_000_000_000_000n,
            probability: 0.5,
          },
        ],
      },
    });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(marketCommand);
    await runViaProgram(program, leafName, [MARKET_ADDRESS], ['--json', '--quiet']);

    const json = parseJsonStdout(capture) as {
      marketAddress: string;
      status: string;
      reserveWad: string;
      outcomes: { probability: number }[];
    };
    expect(json.marketAddress).toBe(MARKET_ADDRESS);
    expect(json.status).toBe('active');
    expect(json.reserveWad).toBe('1000000000000000000000');
    expect(json.outcomes).toHaveLength(2);
    expect(json.outcomes[0]!.probability).toBe(0.5);
  });

  it('rejects a malformed market address', async () => {
    const stub = stubDirectClient({});
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(marketCommand);
    await expect(runViaProgram(program, leafName, ['nope'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('kash protocol quote', () => {
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

  it('converts human USDC decimal to atomic-6 on BUY', async () => {
    const stub = stubDirectClient({
      quote: {
        side: 'BUY',
        outcomeIndex: 0,
        amountIn: 10_000_000n,
        amountOut: 16_000_000_000_000_000_000n,
        reserveAfterWad: 0n,
        pricesAfterWad: [600_000_000_000_000_000n, 400_000_000_000_000_000n],
      },
    });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(quoteCommand);
    await runViaProgram(program, leafName, [
      MARKET_ADDRESS,
      '--side',
      'buy',
      '--outcome',
      '0',
      '--amount',
      '10',
    ]);

    expect(stub.client.markets.quote).toHaveBeenCalledWith(MARKET_ADDRESS, {
      side: 'BUY',
      outcome: 0,
      amount: 10_000_000n,
    });
  });

  it('converts human token decimal to WAD-18 on SELL', async () => {
    const stub = stubDirectClient({
      quote: {
        side: 'SELL',
        outcomeIndex: 1,
        amountIn: 1_500_000_000_000_000_000n,
        amountOut: 750_000n,
        reserveAfterWad: 0n,
        pricesAfterWad: [500_000_000_000_000_000n, 500_000_000_000_000_000n],
      },
    });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(quoteCommand);
    await runViaProgram(program, leafName, [
      MARKET_ADDRESS,
      '--side',
      'sell',
      '--outcome',
      '1',
      '--amount',
      '1.5',
    ]);

    expect(stub.client.markets.quote).toHaveBeenCalledWith(MARKET_ADDRESS, {
      side: 'SELL',
      outcome: 1,
      amount: 1_500_000_000_000_000_000n,
    });
  });

  it('rejects an unknown --side value', async () => {
    const stub = stubDirectClient({});
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(quoteCommand);
    await expect(
      runViaProgram(program, leafName, [
        MARKET_ADDRESS,
        '--side',
        'whatever',
        '--outcome',
        '0',
        '--amount',
        '10',
      ])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('maps a KashSimulationRevertedError to TRANSACTION_REVERTED', async () => {
    const stub = stubDirectClient({ throwOn: 'quote' });
    buildDirectClientMock.mockResolvedValue(stub);

    const { program, leafName } = wrapInProgram(quoteCommand);
    await expect(
      runViaProgram(program, leafName, [
        MARKET_ADDRESS,
        '--side',
        'buy',
        '--outcome',
        '0',
        '--amount',
        '1',
      ])
    ).rejects.toMatchObject({
      code: 'TRANSACTION_REVERTED',
    });
  });
});
