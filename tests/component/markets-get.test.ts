/**
 * Component tests for `kash markets get <id>`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KashNotFoundError } from '@kashdao/sdk';

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
const { getMarketCommand } = await import('../../src/commands/markets/get.js');
const buildClientMock = vi.mocked(buildClient);

const market = {
  id: '00000000-0000-0000-0000-000000000001',
  contractAddress: '0xabc',
  chainId: 8453,
  title: 'Election',
  description: 'who wins',
  status: 'ACTIVE' as const,
  outcomeCount: 2,
  outcomes: [
    { index: 0, label: 'A', probability: 0.55 },
    { index: 1, label: 'B', probability: 0.45 },
  ],
  imageUrl: null,
  createdAt: '2026-04-30T12:00:00.000Z',
  expiresAt: null,
  resolvedAt: null,
};

describe('kash markets get', () => {
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

  it('emits the resource as JSON in --json mode', async () => {
    const client = makeMockClient();
    client.markets.get.mockResolvedValue(market);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(getMarketCommand);
    await runViaProgram(program, leafName, [market.id], ['--json']);

    const json = parseJsonStdout(capture) as { id: string; outcomes: unknown[] };
    expect(json.id).toBe(market.id);
    expect(json.outcomes).toHaveLength(2);
    // Auth-uniformity invariant: the route requires markets:read.
    expect(buildClientMock).toHaveBeenCalledWith(expect.objectContaining({ requireAuth: true }));
  });

  it('renders a human-readable detail block by default', async () => {
    const client = makeMockClient();
    client.markets.get.mockResolvedValue(market);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(getMarketCommand);
    await runViaProgram(program, leafName, [market.id]);
    expect(capture.stdout).toContain('Election');
    expect(capture.stdout).toContain('55.0%');
  });

  it('maps a 404 to NOT_FOUND', async () => {
    const client = makeMockClient();
    client.markets.get.mockRejectedValue(
      new KashNotFoundError('gone', { code: 'MARKET_NOT_FOUND', statusCode: 404 })
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(getMarketCommand);
    await expect(runViaProgram(program, leafName, ['nope'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
      recoverable: true,
    });
  });
});
