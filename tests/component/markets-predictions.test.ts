/**
 * Component tests for `kash markets predictions`.
 *
 * Mocks `buildClient` and asserts the SDK call shape, JSON output
 * envelope, NDJSON streaming, --all flattening, and the input
 * validators (--side, --outcome, --limit).
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
const { predictionsCommand } = await import('../../src/commands/markets/predictions.js');
const buildClientMock = vi.mocked(buildClient);

const MARKET_ID = '00000000-0000-0000-0000-000000000001';

const SAMPLE_PREDICTION = {
  id: 'pred-01',
  marketId: MARKET_ID,
  outcomeIndex: 0,
  side: 'buy' as const,
  usdcIn: '100000000',
  usdcOut: null,
  tokensIn: null,
  tokensOut: '149231587123456789012',
  price: '0.6701234',
  probability: '0.62',
  timestamp: '2026-04-30T12:00:00.000Z',
  blockNumber: '12345678',
  transactionHash: `0x${'a'.repeat(64)}`,
  logIndex: 0,
};

/**
 * Build a fake `Page<Prediction>` matching the SDK shape: array data
 * + pagination + asyncIterator yielding entries across pages.
 */
function makePage(items: unknown[], hasMore = false, cursor: string | null = null): unknown {
  return {
    data: items,
    pagination: { cursor, hasMore, limit: items.length },
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

describe('kash markets predictions', () => {
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

  it('emits a paginated envelope in --json mode', async () => {
    const client = makeMockClient();
    (client.markets as { predictions: ReturnType<typeof vi.fn> }).predictions = vi.fn(() =>
      Promise.resolve(makePage([SAMPLE_PREDICTION], true, 'cur-2'))
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(predictionsCommand);
    await runViaProgram(program, leafName, [MARKET_ID], ['--json']);

    const json = parseJsonStdout(capture) as {
      data: { id: string }[];
      pagination: { hasMore: boolean; cursor: string | null };
    };
    expect(json.data[0]!.id).toBe('pred-01');
    expect(json.pagination.hasMore).toBe(true);
    expect(json.pagination.cursor).toBe('cur-2');
    // Auth-uniformity invariant: the route requires markets:read.
    expect(buildClientMock).toHaveBeenCalledWith(expect.objectContaining({ requireAuth: true }));
  });

  it('forwards --side and --outcome to the SDK', async () => {
    const client = makeMockClient();
    const predictionsFn = vi.fn(() => Promise.resolve(makePage([], false, null)));
    (client.markets as { predictions: typeof predictionsFn }).predictions = predictionsFn;
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(predictionsCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--side', 'buy', '--outcome', '1']);

    expect(predictionsFn).toHaveBeenCalledWith(
      MARKET_ID,
      expect.objectContaining({ side: 'buy', outcomeIndex: 1, limit: 50 })
    );
  });

  it('rejects an invalid --side', async () => {
    const { program, leafName } = wrapInProgram(predictionsCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--side', 'lend'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects out-of-range --limit (>100)', async () => {
    const { program, leafName } = wrapInProgram(predictionsCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--limit', '500'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('--all walks every page and emits a count', async () => {
    const client = makeMockClient();
    const items = [
      { ...SAMPLE_PREDICTION, id: 'pred-01' },
      { ...SAMPLE_PREDICTION, id: 'pred-02' },
      { ...SAMPLE_PREDICTION, id: 'pred-03' },
    ];
    (client.markets as { predictions: ReturnType<typeof vi.fn> }).predictions = vi.fn(() =>
      Promise.resolve(makePage(items, false, null))
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(predictionsCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--all'], ['--json']);

    const json = parseJsonStdout(capture) as { data: unknown[]; count: number };
    expect(json.count).toBe(3);
    expect(json.data).toHaveLength(3);
  });

  it('--ndjson emits one record per line', async () => {
    const client = makeMockClient();
    const items = [
      { ...SAMPLE_PREDICTION, id: 'pred-01' },
      { ...SAMPLE_PREDICTION, id: 'pred-02' },
    ];
    (client.markets as { predictions: ReturnType<typeof vi.fn> }).predictions = vi.fn(() =>
      Promise.resolve(makePage(items, false, null))
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(predictionsCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--ndjson']);

    const lines = capture.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toHaveProperty('id');
    }
  });
});
