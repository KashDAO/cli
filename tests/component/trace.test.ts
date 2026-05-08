/**
 * Component tests for `kash trace <correlationId>`.
 *
 * Mocks `buildClient` to return a stub `KashClient` whose `traces.get`
 * returns a fixed timeline. Verifies:
 *   - input validation (UUID),
 *   - the SDK is called with the right arg,
 *   - JSON output matches the SDK shape,
 *   - human output renders the timeline lines,
 *   - 404s map to a CliError with `code: NOT_FOUND`.
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
const { traceCommand } = await import('../../src/commands/trace.js');
const buildClientMock = vi.mocked(buildClient);

const CORRELATION_ID = '33333333-3333-3333-3333-333333333333';
const TRADE_ID = '11111111-1111-1111-1111-111111111111';
const TX_HASH = `0x${'a'.repeat(64)}`;

const SAMPLE_TRACE = {
  correlationId: CORRELATION_ID,
  events: [
    {
      type: 'com.kash.intent.parsed.v1',
      occurredAt: '2026-05-02T12:00:00.000Z',
      sequenceNumber: 0,
      data: {
        tradeId: TRADE_ID,
        marketId: '22222222-2222-2222-2222-222222222222',
        outcomeIndex: 0,
        side: 'buy' as const,
        amount: '10',
      },
    },
    {
      type: 'com.kash.trade.executed.v1',
      occurredAt: '2026-05-02T12:00:03.000Z',
      sequenceNumber: 3,
      data: {
        tradeId: TRADE_ID,
        txHash: TX_HASH,
        tokensOut: '149231587123456789012',
      },
    },
  ],
};

describe('kash trace', () => {
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

  it('emits the SDK trace shape on --json', async () => {
    const client = makeMockClient();
    client.traces.get.mockResolvedValue(SAMPLE_TRACE);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(traceCommand);
    await runViaProgram(program, leafName, [CORRELATION_ID], ['--json']);

    expect(client.traces.get).toHaveBeenCalledWith(CORRELATION_ID);
    const json = parseJsonStdout(capture) as {
      correlationId: string;
      events: { type: string; data: { txHash?: string } }[];
    };
    expect(json.correlationId).toBe(CORRELATION_ID);
    expect(json.events).toHaveLength(2);
    expect(json.events[0]!.type).toBe('com.kash.intent.parsed.v1');
    expect(json.events[1]!.data.txHash).toBe(TX_HASH);
  });

  it('renders a human timeline by default', async () => {
    const client = makeMockClient();
    client.traces.get.mockResolvedValue(SAMPLE_TRACE);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(traceCommand);
    await runViaProgram(program, leafName, [CORRELATION_ID]);

    // Header + per-event lines should render.
    expect(capture.stdout).toContain(CORRELATION_ID);
    // Type column: stripped prefix + suffix.
    expect(capture.stdout).toContain('intent.parsed');
    expect(capture.stdout).toContain('trade.executed');
    // Curated data should appear.
    expect(capture.stdout).toContain(`trade=${TRADE_ID.slice(0, 8)}`);
    // Tx hash should appear truncated.
    expect(capture.stdout).toContain(TX_HASH.slice(0, 10));
  });

  it('handles an empty timeline gracefully (no events)', async () => {
    const client = makeMockClient();
    client.traces.get.mockResolvedValue({ correlationId: CORRELATION_ID, events: [] });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(traceCommand);
    await runViaProgram(program, leafName, [CORRELATION_ID]);

    expect(capture.stdout).toContain(CORRELATION_ID);
    // Empty hint must be present so users don't think the command failed.
    expect(capture.stdout).toMatch(/no events/i);
  });

  it('rejects a non-UUID correlation id with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(traceCommand);
    await expect(runViaProgram(program, leafName, ['not-a-uuid'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // SDK must NOT have been called.
    expect(buildClientMock).not.toHaveBeenCalled();
  });

  it('translates KashNotFoundError to CliError NOT_FOUND', async () => {
    const client = makeMockClient();
    client.traces.get.mockRejectedValue(
      new KashNotFoundError('Trace not found', {
        code: 'RESOURCE_NOT_FOUND',
        statusCode: 404,
      })
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(traceCommand);
    await expect(runViaProgram(program, leafName, [CORRELATION_ID])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
