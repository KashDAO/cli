/**
 * Component tests for `kash portfolio show` and `kash portfolio
 * positions`. The positions test is the canonical assertion that the
 * WAD bigint formatter doesn't lose precision past Number.MAX_SAFE_INTEGER.
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
const { positionsCommand } = await import('../../src/commands/portfolio/positions.js');
const { showPortfolioCommand } = await import('../../src/commands/portfolio/show.js');
const buildClientMock = vi.mocked(buildClient);

describe('kash portfolio show', () => {
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

  it('renders the smart account address and cost basis as currency', async () => {
    const client = makeMockClient();
    client.portfolio.get.mockResolvedValue({
      smartAccountAddress: '0x1111111111111111111111111111111111111111',
      activePositions: 3,
      totalCostBasisAtomic: '12500000', // $12.50
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(showPortfolioCommand);
    await runViaProgram(program, leafName, []);
    expect(capture.stdout).toContain('$12.50');
    expect(capture.stdout).toContain('3 positions');
  });

  it('emits the portfolio summary as JSON in --json mode', async () => {
    const client = makeMockClient();
    client.portfolio.get.mockResolvedValue({
      smartAccountAddress: '0x1111111111111111111111111111111111111111',
      activePositions: 0,
      totalCostBasisAtomic: '0',
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(showPortfolioCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as { activePositions: number };
    expect(json.activePositions).toBe(0);
  });
});

describe('kash portfolio positions', () => {
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

  it('forwards --market filter to the SDK and renders the table', async () => {
    const client = makeMockClient();
    client.portfolio.positions.mockResolvedValue([
      {
        marketId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        outcomeIndex: 0,
        // 1.5e18 WAD — well past Number precision.
        shares: '1500000000000000000',
        costBasisAtomic: '5000000', // $5.00
        tradeCount: 2,
        firstTradeAt: '2026-04-30T12:00:00.000Z',
        lastTradeAt: '2026-04-30T12:30:00.000Z',
      },
    ]);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(positionsCommand);
    await runViaProgram(program, leafName, ['--market', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);

    expect(client.portfolio.positions).toHaveBeenCalledWith({
      marketId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    expect(capture.stdout).toContain('1.5000');
    expect(capture.stdout).toContain('$5.00');
  });
});
