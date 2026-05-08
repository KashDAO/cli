/**
 * Component tests for `kash webhooks rotate-secret` and
 * `kash webhooks redeliver`.
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
const { redeliverCommand } = await import('../../src/commands/webhooks/redeliver.js');
const { rotateSecretCommand } = await import('../../src/commands/webhooks/rotate-secret.js');
const buildClientMock = vi.mocked(buildClient);

describe('kash webhooks rotate-secret', () => {
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

  it('prints the new secret in human mode', async () => {
    const client = makeMockClient();
    client.webhooks.rotateSecret.mockResolvedValue({
      secret: 'whsec_topsecret',
      rotatedAt: '2026-04-30T12:00:00.000Z',
      previousRetainedUntil: '2026-04-30T13:00:00.000Z',
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(rotateSecretCommand);
    await runViaProgram(program, leafName, []);
    expect(capture.stdout).toContain('whsec_topsecret');
  });

  it('emits the rotation envelope as JSON', async () => {
    const client = makeMockClient();
    client.webhooks.rotateSecret.mockResolvedValue({
      secret: 'whsec_topsecret',
      rotatedAt: '2026-04-30T12:00:00.000Z',
      previousRetainedUntil: '2026-04-30T13:00:00.000Z',
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(rotateSecretCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as { secret: string };
    expect(json.secret).toBe('whsec_topsecret');
  });
});

describe('kash webhooks redeliver', () => {
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

  it('forwards the eventId and prints the queued event', async () => {
    const client = makeMockClient();
    client.webhooks.redeliver.mockResolvedValue({
      id: '99999999-9999-9999-9999-999999999999',
      eventType: 'trade.completed',
      apiKeyId: '88888888-8888-8888-8888-888888888888',
      tradeRequestId: '77777777-7777-7777-7777-777777777777',
      emittedAt: '2026-04-30T12:00:00.000Z',
      lastDeliveredAt: null,
      deliveryAttempts: 1,
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(redeliverCommand);
    await runViaProgram(program, leafName, ['99999999-9999-9999-9999-999999999999']);
    expect(client.webhooks.redeliver).toHaveBeenCalledWith('99999999-9999-9999-9999-999999999999');
    expect(capture.stdout).toContain('trade.completed');
  });

  // Pre-flight UUID shape check — saves an API round-trip on typos
  // and surfaces `INVALID_INPUT` instead of a confusing 404.
  it('rejects non-UUID event ids with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(redeliverCommand);
    await expect(runViaProgram(program, leafName, ['not-a-uuid'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // Look-alike but not a UUID (the tradeId of the trade resource,
    // perhaps — wrong field).
    await expect(runViaProgram(program, leafName, ['evt_9f0b'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // Buildclient never reached.
    expect(buildClientMock).not.toHaveBeenCalled();
  });
});
