/**
 * Component tests for `kash redeem <marketId> --outcome <index>`.
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
const { redeemCommand } = await import('../../src/commands/redeem.js');
const buildClientMock = vi.mocked(buildClient);

const MARKET_ID = '00000000-0000-0000-0000-000000000001';

const redemption = {
  id: '00000000-0000-0000-0000-000000000020',
  marketId: MARKET_ID,
  outcomeIndex: 42,
  kind: 'resolved' as const,
  sharesWad: '125000000000000000000',
  status: 'pending',
  idempotent: false,
};

describe('kash redeem', () => {
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

  it('requests the redemption and emits it as JSON', async () => {
    const client = makeMockClient();
    client.redemptions.create.mockResolvedValue(redemption);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '42'], ['--json']);

    // Outcome 42 is past the old [0, 7] ceiling; 96-outcome markets exist.
    expect(client.redemptions.create).toHaveBeenCalledWith(
      { marketId: MARKET_ID, outcomeIndex: 42 },
      {}
    );
    expect(buildClientMock).toHaveBeenCalledWith(expect.objectContaining({ requireAuth: true }));
    const json = parseJsonStdout(capture) as { id: string; kind: string };
    expect(json).toMatchObject({ id: redemption.id, kind: 'resolved' });
  });

  it('forwards --idempotency-key', async () => {
    const client = makeMockClient();
    client.redemptions.create.mockResolvedValue(redemption);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await runViaProgram(program, leafName, [
      MARKET_ID,
      '--outcome',
      '0',
      '--idempotency-key',
      'claim-1',
    ]);

    expect(client.redemptions.create).toHaveBeenCalledWith(
      { marketId: MARKET_ID, outcomeIndex: 0 },
      { idempotencyKey: 'claim-1' }
    );
  });

  it('--auto-idempotency-key generates a UUID, sends it and surfaces it in JSON', async () => {
    const client = makeMockClient();
    client.redemptions.create.mockResolvedValue(redemption);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '0', '--auto-idempotency-key'],
      ['--json']
    );

    const sent = client.redemptions.create.mock.calls[0]![1] as { idempotencyKey: string };
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const json = parseJsonStdout(capture) as { idempotencyKey: string };
    expect(json.idempotencyKey).toBe(sent.idempotencyKey);
  });

  it('an explicit --idempotency-key wins over --auto-idempotency-key and is printed', async () => {
    const client = makeMockClient();
    client.redemptions.create.mockResolvedValue(redemption);
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await runViaProgram(program, leafName, [
      MARKET_ID,
      '--outcome',
      '0',
      '--idempotency-key',
      'claim-7',
      '--auto-idempotency-key',
    ]);

    expect(client.redemptions.create.mock.calls[0]![1]).toEqual({ idempotencyKey: 'claim-7' });
    expect(capture.stdout).toContain('claim-7');
  });

  it('--dry-run sends nothing and never builds a client', async () => {
    const client = makeMockClient();
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await runViaProgram(
      program,
      leafName,
      [MARKET_ID, '--outcome', '3', '--idempotency-key', 'claim-9', '--dry-run'],
      ['--json']
    );

    expect(buildClientMock).not.toHaveBeenCalled();
    expect(client.redemptions.create).not.toHaveBeenCalled();
    expect(parseJsonStdout(capture)).toEqual({
      wouldSend: { marketId: MARKET_ID, outcomeIndex: 3 },
      idempotencyKey: 'claim-9',
      endpoint: { method: 'POST', path: '/v1/redemptions' },
    });
  });

  it('--dry-run still validates the outcome index', async () => {
    const { program, leafName } = wrapInProgram(redeemCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--outcome', '100', '--dry-run'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('renders a human-readable summary, flagging an existing request', async () => {
    const client = makeMockClient();
    client.redemptions.create.mockResolvedValue({ ...redemption, idempotent: true });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await runViaProgram(program, leafName, [MARKET_ID, '--outcome', '42']);

    const output = capture.stdout + capture.stderr;
    expect(output).toContain('already requested');
    expect(output).toContain('resolved');
    expect(output).toContain('pending');
  });

  it('rejects an out-of-range outcome before calling the API', async () => {
    const client = makeMockClient();
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--outcome', '100'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(client.redemptions.create).not.toHaveBeenCalled();
  });

  it('maps POSITION_NOT_CLAIMABLE to CONFLICT', async () => {
    const client = makeMockClient();
    client.redemptions.create.mockRejectedValue(
      new KashConflictError('nothing to redeem', {
        code: 'POSITION_NOT_CLAIMABLE',
        statusCode: 409,
      })
    );
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeemCommand);
    await expect(
      runViaProgram(program, leafName, [MARKET_ID, '--outcome', '1'])
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
