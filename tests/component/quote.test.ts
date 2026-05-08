/**
 * Component tests for `kash quote buy/sell`.
 *
 * Covers the unit-conversion path (human USDC decimal → atomic-6,
 * human token decimal → WAD-18) since the SDK expects atomic/WAD
 * strings and a regression there silently lands wrong-magnitude
 * orders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import {
  captureStreams,
  makeMockClient,
  parseJsonStdout,
  runViaProgram,
  wrapInProgram,
} from './harness.js';

vi.mock('../../src/utils/client.js', () => ({
  buildClient: vi.fn(),
}));

const { buildClient } = await import('../../src/utils/client.js');
const { buyQuoteCommand } = await import('../../src/commands/quote/buy.js');
const { sellQuoteCommand } = await import('../../src/commands/quote/sell.js');
const buildClientMock = vi.mocked(buildClient);

const MARKET_ID = '00000000-0000-0000-0000-000000000001';
const sampleQuote = {
  action: 'buy' as const,
  outcomeIndex: 0,
  amountIn: '10000000', // 10 USDC atomic
  tokensOut: '5000000000000000000', // 5 tokens WAD
  reserveAfter: '0',
  c: '0',
  pAfter: ['500000000000000000', '500000000000000000'],
  qAfter: ['0', '0'],
  effectivePrice: 0.5,
  impliedProbability: 0.5,
  market: {
    id: MARKET_ID,
    contractAddress: '0xabc',
    chainId: 8453,
    outcomes: [
      { index: 0, label: 'Yes', probability: 0.5 },
      { index: 1, label: 'No', probability: 0.5 },
    ],
    status: 'ACTIVE' as const,
  },
};

describe('kash quote buy', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('converts human USDC decimal to atomic-6 before calling the SDK', async () => {
    const client = makeMockClient();
    client.quotes.buy.mockResolvedValue(sampleQuote);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyQuoteCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', '10']);

    expect(client.quotes.buy).toHaveBeenCalledWith({
      marketId: MARKET_ID,
      outcomeIndex: 0,
      amountUsdcAtomic: '10000000', // 10 * 1e6
    });
    // Auth-uniformity invariant: the route requires markets:quote.
    expect(buildClientMock).toHaveBeenCalledWith(expect.objectContaining({ requireAuth: true }));
  });

  it('handles fractional USDC ("0.50" → "500000")', async () => {
    const client = makeMockClient();
    client.quotes.buy.mockResolvedValue(sampleQuote);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyQuoteCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', '0.50']);

    expect(client.quotes.buy).toHaveBeenCalledWith(
      expect.objectContaining({ amountUsdcAtomic: '500000' })
    );
  });

  it('emits the quote as JSON in --json mode', async () => {
    const client = makeMockClient();
    client.quotes.buy.mockResolvedValue(sampleQuote);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyQuoteCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '0', '--amount', '10'],
      ['--json']
    );

    const json = parseJsonStdout(capture) as { tokensOut: string; effectivePrice: number };
    expect(json.tokensOut).toBe('5000000000000000000');
    expect(json.effectivePrice).toBe(0.5);
  });

  it('rejects malformed --amount with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(buyQuoteCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', 'not-a-number'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects USDC values past 6 fractional digits', async () => {
    const { program, leafName } = wrapInProgram(buyQuoteCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', '0.0000001'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('kash quote sell', () => {
  let teardown: () => void;

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    configureOutput({ quiet: false, noColor: true });
    buildClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('converts human token decimal to WAD-18', async () => {
    const client = makeMockClient();
    const sellQuote = { ...sampleQuote, action: 'sell' as const };
    client.quotes.sell.mockResolvedValue(sellQuote);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(sellQuoteCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--tokens', '1.5']);

    expect(client.quotes.sell).toHaveBeenCalledWith({
      marketId: MARKET_ID,
      outcomeIndex: 0,
      tokensInWad: '1500000000000000000', // 1.5 * 1e18
    });
    // Auth-uniformity invariant: the route requires markets:quote.
    expect(buildClientMock).toHaveBeenCalledWith(expect.objectContaining({ requireAuth: true }));
  });

  it('handles small token decimals ("0.0001" → "100000000000000")', async () => {
    const client = makeMockClient();
    const sellQuote = { ...sampleQuote, action: 'sell' as const };
    client.quotes.sell.mockResolvedValue(sellQuote);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(sellQuoteCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--tokens', '0.0001']);

    expect(client.quotes.sell).toHaveBeenCalledWith(
      expect.objectContaining({ tokensInWad: '100000000000000' })
    );
  });
});
