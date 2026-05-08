/**
 * Component tests for `kash markets list`.
 *
 * Each test wraps the leaf command in a temporary root program (so
 * Commander's --json/--quiet globals resolve), pins SDK responses
 * via a mocked `buildClient`, and asserts both human and JSON output
 * paths plus error mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KashRateLimitError } from '@kashdao/sdk';

import { CliError, EXIT_CODES } from '../../src/errors.js';
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
const { listMarketsCommand } = await import('../../src/commands/markets/list.js');

const buildClientMock = vi.mocked(buildClient);

const sampleMarket = {
  id: '00000000-0000-0000-0000-000000000001',
  contractAddress: '0xabc',
  chainId: 8453,
  title: 'Will it rain tomorrow?',
  description: null,
  status: 'ACTIVE' as const,
  outcomeCount: 2,
  outcomes: [
    { index: 0, label: 'Yes', probability: 0.62 },
    { index: 1, label: 'No', probability: 0.38 },
  ],
  imageUrl: null,
  createdAt: '2026-04-30T12:00:00.000Z',
  expiresAt: null,
  resolvedAt: null,
};

describe('kash markets list', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildClientMock.mockReset();
  });

  afterEach(() => {
    teardown();
  });

  it('renders a human-readable table by default', async () => {
    const client = makeMockClient();
    client.markets.list.mockResolvedValue({
      data: [sampleMarket],
      pagination: { cursor: null, hasMore: false, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await runViaProgram(program, leafName, []);

    expect(client.markets.list).toHaveBeenCalledWith({ limit: 20 });
    // Auth-uniformity invariant: every market route requires an API key.
    // Asserting the mock call shape here means a future regression to
    // `requireAuth: false` (or omitting it) fails CI immediately.
    expect(buildClientMock).toHaveBeenCalledWith(expect.objectContaining({ requireAuth: true }));
    expect(capture.stdout).toContain('Will it rain tomorrow');
    expect(capture.stdout).toContain('ACTIVE');
  });

  it('emits machine-readable JSON in --json mode', async () => {
    const client = makeMockClient();
    client.markets.list.mockResolvedValue({
      data: [sampleMarket],
      pagination: { cursor: 'cur_2', hasMore: true, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as {
      data: { id: string }[];
      pagination: { hasMore: boolean };
    };
    expect(json.data[0]!.id).toBe(sampleMarket.id);
    expect(json.pagination.hasMore).toBe(true);
  });

  it('--json --quiet emits compact (single-line) JSON, --json alone emits pretty', async () => {
    const client = makeMockClient();
    client.markets.list.mockResolvedValue({
      data: [sampleMarket],
      pagination: { cursor: null, hasMore: false, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    // --json --quiet → single-line compact (better for jq -c / xargs).
    const compactRun = wrapInProgram(listMarketsCommand);
    await runViaProgram(compactRun.program, compactRun.leafName, [], ['--json', '--quiet']);
    const compactStdout = capture.stdout.trim();
    expect(compactStdout).not.toContain('\n');
    expect(JSON.parse(compactStdout)).toBeDefined();

    // --json alone → pretty-printed across multiple lines.
    capture.stdout = '';
    capture.stderr = '';
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });
    const prettyRun = wrapInProgram(listMarketsCommand);
    await runViaProgram(prettyRun.program, prettyRun.leafName, [], ['--json']);
    expect(capture.stdout.trim().split('\n').length).toBeGreaterThan(1);
  });

  it('forwards --status (uppercased) to the SDK', async () => {
    const client = makeMockClient();
    client.markets.list.mockResolvedValue({
      data: [],
      pagination: { cursor: null, hasMore: false, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await runViaProgram(program, leafName, ['--status', 'active']);

    expect(client.markets.list).toHaveBeenCalledWith({ limit: 20, status: 'ACTIVE' });
  });

  it('rejects an invalid status with a structured CliError', async () => {
    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await expect(runViaProgram(program, leafName, ['--status', 'pending'])).rejects.toBeInstanceOf(
      CliError
    );
  });

  it('rejects out-of-range --limit with a structured CliError and exit 1', async () => {
    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await expect(runViaProgram(program, leafName, ['--limit', '500'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      exitCode: EXIT_CODES.GENERIC,
    });
  });

  it('translates a KashRateLimitError into a recoverable CliError', async () => {
    const client = makeMockClient();
    client.markets.list.mockRejectedValue(
      new KashRateLimitError('slow', {
        code: 'RATE_LIMIT_EXCEEDED',
        statusCode: 429,
        retryAfterSeconds: 30,
      })
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await expect(runViaProgram(program, leafName, [])).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      recoverable: true,
      retryAfterMs: 30_000,
    });
  });

  it('--fields narrows entries inside the paginated envelope', async () => {
    const client = makeMockClient();
    client.markets.list.mockResolvedValue({
      data: [sampleMarket],
      pagination: { cursor: 'cur_2', hasMore: true, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await runViaProgram(program, leafName, [], ['--json', '--fields', 'id,status,outcomes.label']);

    const json = parseJsonStdout(capture) as {
      data: { id: string; status: string; outcomes: { label: string }[]; title?: string }[];
      pagination: { hasMore: boolean };
    };
    // Entry is narrowed.
    expect(json.data[0]).toEqual({
      id: sampleMarket.id,
      status: 'ACTIVE',
      outcomes: [{ label: 'Yes' }, { label: 'No' }],
    });
    // Fields not requested are absent (no `title`, no `contractAddress`).
    expect(json.data[0]).not.toHaveProperty('title');
    // Pagination is preserved unchanged — agents need it to follow cursors.
    expect(json.pagination).toEqual({ cursor: 'cur_2', hasMore: true, limit: 20 });
  });

  it('--fields rejects bad path syntax with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await expect(
      runViaProgram(program, leafName, [], ['--json', '--fields', 'outcomes[].label'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('--filter narrows entries by predicate inside the paginated envelope', async () => {
    const client = makeMockClient();
    const matching = { ...sampleMarket, id: 'match-1', status: 'ACTIVE' as const };
    const nonMatching = { ...sampleMarket, id: 'nope', status: 'RESOLVED' as const };
    client.markets.list.mockResolvedValue({
      data: [matching, nonMatching],
      pagination: { cursor: null, hasMore: false, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await runViaProgram(program, leafName, [], ['--json', '--filter', 'status==ACTIVE']);

    const json = parseJsonStdout(capture) as { data: { id: string; status: string }[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]!.id).toBe('match-1');
  });

  it('--filter combines with --fields (filter first, then project)', async () => {
    const client = makeMockClient();
    client.markets.list.mockResolvedValue({
      data: [
        { ...sampleMarket, id: 'a', status: 'ACTIVE' as const, outcomeCount: 2 },
        { ...sampleMarket, id: 'b', status: 'ACTIVE' as const, outcomeCount: 4 },
        { ...sampleMarket, id: 'c', status: 'RESOLVED' as const, outcomeCount: 4 },
      ],
      pagination: { cursor: null, hasMore: false, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await runViaProgram(
      program,
      leafName,
      [],
      ['--json', '--filter', 'status==ACTIVE && outcomeCount>2', '--fields', 'id']
    );

    const json = parseJsonStdout(capture) as { data: { id: string; status?: string }[] };
    // Only `b` survives both filter and projection.
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toEqual({ id: 'b' });
    // `status` was used by the filter but projected away.
    expect(json.data[0]).not.toHaveProperty('status');
  });

  it('--filter rejects malformed expressions with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await expect(
      runViaProgram(program, leafName, [], ['--json', '--filter', 'status~=ACTIVE'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('--quiet suppresses informational stderr noise', async () => {
    const client = makeMockClient();
    client.markets.list.mockResolvedValue({
      data: [],
      pagination: { cursor: null, hasMore: false, limit: 20 },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listMarketsCommand);
    await runViaProgram(program, leafName, [], ['--quiet']);

    // The empty-result branch in markets/list calls `log.info('No markets …')`,
    // which writes to stderr in human mode. With --quiet, stderr must be silent
    // so an agent piping `2>&1` doesn't see info noise mixed with errors.
    expect(capture.stderr).toBe('');
  });
});
