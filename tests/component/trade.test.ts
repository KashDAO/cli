/**
 * Component tests for the `kash trade` command group.
 *
 * Exercises the buy/sell happy path, the high-value confirmation
 * branch, idempotency-key plumbing, polling via --wait, status/list
 * round trips, and the confirm command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KashConflictError } from '@kashdao/sdk';

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
const { buyCommand } = await import('../../src/commands/trade/buy.js');
const { confirmCommand } = await import('../../src/commands/trade/confirm.js');
const { listTradesCommand } = await import('../../src/commands/trade/list.js');
const { sellCommand } = await import('../../src/commands/trade/sell.js');
const { statusCommand } = await import('../../src/commands/trade/status.js');
const buildClientMock = vi.mocked(buildClient);

const TRADE_ID = '11111111-1111-1111-1111-111111111111';
const MARKET_ID = '22222222-2222-2222-2222-222222222222';
const TX_HASH = `0x${'a'.repeat(64)}`;

function tradeResource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TRADE_ID,
    marketId: MARKET_ID,
    outcomeIndex: 0,
    amount: '10',
    side: 'buy' as const,
    status: 'pending' as const,
    correlationId: '33333333-3333-3333-3333-333333333333',
    clientRequestId: null,
    txHash: null,
    tokensOut: null,
    errorCode: null,
    errorMessage: null,
    webhookDelivery: null,
    createdAt: '2026-04-30T12:00:00.000Z',
    updatedAt: '2026-04-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('kash trade buy', () => {
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

  it('forwards request body and prints the trade id (default human mode)', async () => {
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({ ...tradeResource(), idempotent: false });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', '10']);

    expect(client.trades.create).toHaveBeenCalledWith(
      { marketId: MARKET_ID, outcomeIndex: 0, amount: '10', side: 'buy' },
      {}
    );
    expect(capture.stdout).toContain(TRADE_ID);
  });

  it('--auto-idempotency-key generates a UUID and surfaces it in --json output', async () => {
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({ ...tradeResource(), idempotent: false });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '0', '--amount', '10', '--auto-idempotency-key'],
      ['--json']
    );

    const call = client.trades.create.mock.calls[0]!;
    const opts = call[1] as { idempotencyKey?: string };
    expect(opts.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);

    const json = parseJsonStdout(capture) as { idempotencyKey?: string; id: string };
    expect(json.id).toBe(TRADE_ID);
    expect(json.idempotencyKey).toBe(opts.idempotencyKey);
  });

  it('explicit --idempotency-key wins over --auto-idempotency-key', async () => {
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({ ...tradeResource(), idempotent: false });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(program, leafName, [
      MARKET_ID,
      '--outcome',
      '0',
      '--amount',
      '10',
      '--idempotency-key',
      'pinned-key',
      '--auto-idempotency-key',
    ]);

    const opts = client.trades.create.mock.calls[0]![1] as { idempotencyKey?: string };
    expect(opts.idempotencyKey).toBe('pinned-key');
  });

  it('explicit --idempotency-key surfaces in --json output', async () => {
    // Tier 1.10 invariant: any idempotency key the CLI sends MUST be
    // visible in the --json response so retry loops can re-use it
    // verbatim. Auto-generated keys are tested above; this locks in
    // the explicit-key path.
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({ ...tradeResource(), idempotent: true });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '0', '--amount', '10', '--idempotency-key', 'pinned-key'],
      ['--json']
    );

    const json = parseJsonStdout(capture) as { idempotencyKey?: string; idempotent: boolean };
    expect(json.idempotencyKey).toBe('pinned-key');
    expect(json.idempotent).toBe(true);
  });

  it('--wait polls to terminal and renders the resolved trade', async () => {
    const client = makeMockClient();
    const completed = tradeResource({ status: 'completed', txHash: TX_HASH, tokensOut: '1234' });
    client.trades.create.mockResolvedValue({ ...tradeResource(), idempotent: false });
    client.trades.waitForCompletion.mockResolvedValue(completed);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(program, leafName, [
      MARKET_ID,
      '--outcome',
      '0',
      '--amount',
      '10',
      '--wait',
    ]);

    expect(client.trades.waitForCompletion).toHaveBeenCalledWith(TRADE_ID, expect.any(Object));
    expect(capture.stdout).toContain(TX_HASH);
  });

  it('renders the high-value confirmation flow when the SDK returns a 202 shape', async () => {
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({
      ...tradeResource({ status: 'pending_confirmation' }),
      idempotent: false,
      confirmation: { token: 'tok_'.padEnd(50, 'x'), expiresAt: '2026-04-30T12:30:00.000Z' },
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', '999']);

    expect(capture.stdout).toContain('pending_confirmation');
    expect(capture.stdout).toContain('tok_');
  });

  it('rejects an invalid amount with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(buyCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', 'not-a-number'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('--dry-run emits the would-be envelope without calling the SDK', async () => {
    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '0', '--amount', '10', '--dry-run'],
      ['--json']
    );

    // SDK client must not be constructed; --dry-run should work without auth.
    expect(buildClientMock).not.toHaveBeenCalled();

    const json = parseJsonStdout(capture) as {
      wouldSend: { marketId: string; outcomeIndex: number; amount: string; side: string };
      idempotencyKey: string | null;
      endpoint: { method: string; path: string };
    };
    expect(json).toEqual({
      wouldSend: { marketId: MARKET_ID, outcomeIndex: 0, amount: '10', side: 'buy' },
      idempotencyKey: null,
      endpoint: { method: 'POST', path: '/v1/trades' },
    });
  });

  it('--dry-run --auto-idempotency-key surfaces the generated key in the envelope', async () => {
    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '0', '--amount', '10', '--dry-run', '--auto-idempotency-key'],
      ['--json']
    );

    const json = parseJsonStdout(capture) as { idempotencyKey: string };
    expect(json.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('--dry-run propagates --client-request-id into wouldSend', async () => {
    const { program, leafName } = wrapInProgram(buyCommand);
    await runViaProgram(
      program,
      leafName,
      [
        MARKET_ID,
        '--outcome',
        '1',
        '--amount',
        '5.50',
        '--dry-run',
        '--client-request-id',
        'abc-123',
      ],
      ['--json']
    );

    const json = parseJsonStdout(capture) as {
      wouldSend: { clientRequestId?: string; outcomeIndex: number; amount: string };
    };
    expect(json.wouldSend.clientRequestId).toBe('abc-123');
    expect(json.wouldSend.outcomeIndex).toBe(1);
    expect(json.wouldSend.amount).toBe('5.50');
  });

  it('--dry-run still validates inputs (rejects bad outcome index)', async () => {
    const { program, leafName } = wrapInProgram(buyCommand);
    await expect(
      runViaProgram(program, leafName, [
        MARKET_ID,
        '--outcome',
        '99',
        '--amount',
        '10',
        '--dry-run',
      ])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  // Partial-completion guard. The hosted-trade flow assigns
  // `response.id` server-side as soon as `client.trades.create`
  // resolves. If --wait polling subsequently fails, that id must
  // be surfaced so the operator can resume via
  // `kash trade status <id> --poll` rather than losing the pointer
  // to a server-created trade. Symmetric to the SA-mode userop and
  // EOA-mode tx hash partial-completion seams.
  it('--wait surfaces id partial record when waitForCompletion rejects', async () => {
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({ ...tradeResource(), idempotent: false });
    client.trades.waitForCompletion.mockRejectedValue(new Error('poll deadline exceeded'));
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await expect(
      runViaProgram(
        program,
        leafName,
        [MARKET_ID, '--outcome', '0', '--amount', '10', '--wait'],
        ['--json']
      )
    ).rejects.toBeDefined();

    const partial = parseJsonStdout(capture) as {
      id: string;
      status: string;
      waited: boolean;
      partial: boolean;
    };
    expect(partial.id).toBe(TRADE_ID);
    expect(partial.waited).toBe(false);
    expect(partial.partial).toBe(true);
  });

  it('--wait surfaces resume-command on stderr when waitForCompletion rejects (human mode)', async () => {
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({ ...tradeResource(), idempotent: false });
    client.trades.waitForCompletion.mockRejectedValue(new Error('poll deadline exceeded'));
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', '10', '--wait'])
    ).rejects.toBeDefined();

    expect(capture.stderr).toContain(TRADE_ID);
    expect(capture.stderr).toContain('kash trade status');
  });

  it('does NOT emit a partial record when client.trades.create rejects (pre-create failure)', async () => {
    const client = makeMockClient();
    // create fails before the server assigns an id — there is nothing
    // to resume. The CLI must not fabricate a partial-completion record.
    client.trades.create.mockRejectedValue(new Error('create failed'));
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(buyCommand);
    await expect(
      runViaProgram(
        program,
        leafName,
        [MARKET_ID, '--outcome', '0', '--amount', '10', '--wait'],
        ['--json']
      )
    ).rejects.toBeDefined();

    expect(capture.stdout.trim()).toBe('');
    expect(capture.stderr).not.toContain('kash trade status');
  });
});

describe('kash trade sell', () => {
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

  it('passes side: "sell" to the SDK', async () => {
    const client = makeMockClient();
    client.trades.create.mockResolvedValue({
      ...tradeResource({ side: 'sell' }),
      idempotent: false,
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(sellCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '0', '--amount', '5']);

    expect(client.trades.create).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'sell' }),
      expect.any(Object)
    );
  });

  it('--dry-run emits a sell-side envelope without contacting the SDK', async () => {
    const { program, leafName } = wrapInProgram(sellCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '0', '--amount', '5', '--dry-run'],
      ['--json']
    );

    expect(buildClientMock).not.toHaveBeenCalled();

    const json = parseJsonStdout(capture) as {
      wouldSend: { side: string; amount: string };
    };
    expect(json.wouldSend.side).toBe('sell');
    expect(json.wouldSend.amount).toBe('5');
  });
});

describe('kash trade status', () => {
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

  it('without --poll, calls trades.get and renders the resource', async () => {
    const client = makeMockClient();
    client.trades.get.mockResolvedValue(tradeResource({ status: 'executing' }));
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(statusCommand);
    await runViaProgram(program, leafName, [TRADE_ID]);

    expect(client.trades.get).toHaveBeenCalledWith(TRADE_ID);
    expect(capture.stdout).toContain('executing');
  });

  it('with --poll, calls waitForCompletion and renders the terminal resource as JSON', async () => {
    const client = makeMockClient();
    const completed = tradeResource({ status: 'completed', txHash: TX_HASH });
    client.trades.waitForCompletion.mockResolvedValue(completed);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(statusCommand);
    await runViaProgram(program, leafName, [TRADE_ID, '--poll'], ['--json']);

    expect(client.trades.waitForCompletion).toHaveBeenCalled();
    const json = parseJsonStdout(capture) as { txHash: string };
    expect(json.txHash).toBe(TX_HASH);
  });

  it('renders webhookDelivery state when present (human mode)', async () => {
    const client = makeMockClient();
    client.trades.get.mockResolvedValue(
      tradeResource({
        status: 'completed',
        webhookDelivery: {
          status: 'delivered',
          attempts: 2,
          lastAttemptedAt: '2026-04-30T12:05:00.000Z',
          lastStatusCode: 200,
          lastFailureCode: null,
          terminalFailureAt: null,
        },
      })
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(statusCommand);
    await runViaProgram(program, leafName, [TRADE_ID]);

    expect(capture.stdout).toContain('delivered');
    expect(capture.stdout).toContain('attempts=2');
    expect(capture.stdout).toContain('HTTP 200');
  });
});

describe('kash trade list', () => {
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

  it('--ndjson streams one record per line to stdout', async () => {
    const client = makeMockClient();
    const trades = [tradeResource(), tradeResource({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })];
    client.trades.list.mockResolvedValue(asyncIterableOf(trades));
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(listTradesCommand);
    await runViaProgram(program, leafName, ['--ndjson']);

    const lines = capture.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    const records = lines.map((l) => JSON.parse(l) as { id: string });
    expect(records[0]!.id).toBe(TRADE_ID);
    expect(records[1]!.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});

describe('kash trade confirm', () => {
  let teardown: () => void;
  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    configureOutput({ quiet: false, noColor: true });
    buildClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('forwards the token to trades.confirm', async () => {
    const client = makeMockClient();
    client.trades.confirm.mockResolvedValue(tradeResource({ status: 'pending' }));
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(confirmCommand);
    await runViaProgram(program, leafName, [TRADE_ID, 'mytoken']);

    expect(client.trades.confirm).toHaveBeenCalledWith(TRADE_ID, { token: 'mytoken' });
  });

  it('maps a conflict from confirm to CONFLICT', async () => {
    const client = makeMockClient();
    client.trades.confirm.mockRejectedValue(
      new KashConflictError('used', { code: 'CONFIRMATION_TOKEN_USED', statusCode: 409 })
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(confirmCommand);
    await expect(runViaProgram(program, leafName, [TRADE_ID, 'mytoken'])).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  // Mutual-exclusion guard: pre-fix, the positional silently won
  // and the piped token was dropped. On a confirmation flow the
  // captured token + trade id is sufficient to release real money,
  // so silent precedence is a real footgun.
  it('refuses both positional [token] AND --token-stdin together', async () => {
    const { program, leafName } = wrapInProgram(confirmCommand);
    await expect(
      runViaProgram(program, leafName, [TRADE_ID, 'mytoken', '--token-stdin'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

/**
 * Build an object that satisfies both the synchronous list response
 * shape (data + pagination) and the AsyncIterable shape — matches
 * what the SDK's TradesListResult exposes.
 */
function asyncIterableOf<T>(items: readonly T[]): {
  data: readonly T[];
  pagination: { cursor: null; hasMore: false; limit: number };
  [Symbol.asyncIterator](): AsyncIterator<T>;
} {
  return {
    data: items,
    pagination: { cursor: null, hasMore: false, limit: 20 },
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}
