/**
 * Component tests for `kash health`.
 *
 * The SDK's `healthCheck` is non-throwing — failures land as
 * `{ ok: false }` data, not exceptions. The CLI must:
 *   - render the human/JSON output correctly,
 *   - exit non-zero when `ok: false` (so `kash health || exit 1`
 *     gates work),
 *   - still emit the failure shape on stdout in --json mode (agents
 *     branch on the structured result).
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
const { healthCommand } = await import('../../src/commands/health.js');
const buildClientMock = vi.mocked(buildClient);

describe('kash health', () => {
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

  it('renders ok=true with latency in human mode', async () => {
    const client = makeMockClient();
    client.healthCheck.mockResolvedValue({ ok: true, latencyMs: 42, version: '1.2.3' });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(healthCommand);
    await runViaProgram(program, leafName, []);

    expect(capture.stdout).toContain('reachable in 42ms');
    expect(capture.stdout).toContain('1.2.3');
  });

  it('emits the full result as JSON in --json mode', async () => {
    const client = makeMockClient();
    client.healthCheck.mockResolvedValue({ ok: true, latencyMs: 50, status: 'ok' });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(healthCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as { ok: boolean; latencyMs: number };
    expect(json.ok).toBe(true);
    expect(json.latencyMs).toBe(50);
  });

  it('throws a CliError with NETWORK code and exit 1 when ok=false', async () => {
    const client = makeMockClient();
    client.healthCheck.mockResolvedValue({
      ok: false,
      latencyMs: 5000,
      requestId: 'req_abc',
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(healthCommand);
    await expect(runViaProgram(program, leafName, [])).rejects.toMatchObject({
      code: 'NETWORK',
      exitCode: 1,
    });
  });

  it('forwards the global --timeout-ms to the SDK', async () => {
    const client = makeMockClient();
    client.healthCheck.mockResolvedValue({ ok: true, latencyMs: 1 });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    // --timeout-ms is a top-level global flag (consistent with every
    // other SDK-tunable knob), so we pass it via globalArgv.
    const { program, leafName } = wrapInProgram(healthCommand);
    await runViaProgram(program, leafName, [], ['--timeout-ms', '2000']);

    expect(client.healthCheck).toHaveBeenCalledWith({ timeoutMs: 2000 });
  });

  it('uses a 5s default when no --timeout-ms is provided', async () => {
    const client = makeMockClient();
    client.healthCheck.mockResolvedValue({ ok: true, latencyMs: 1 });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(healthCommand);
    await runViaProgram(program, leafName, []);

    expect(client.healthCheck).toHaveBeenCalledWith({ timeoutMs: 5000 });
  });

  // Regression: previously emitted both the success-shape `result` AND
  // an error envelope on the !ok + --json path → two JSON objects on
  // stdout, which broke `jq` consumers. Pin that exactly one JSON
  // envelope reaches stdout, and that it carries the latency / request
  // ID diagnostics merged into the error message.
  it('emits exactly one JSON envelope on the !ok + --json path', async () => {
    const client = makeMockClient();
    client.healthCheck.mockResolvedValue({
      ok: false,
      latencyMs: 5000,
      requestId: 'req_abc',
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(healthCommand);
    await expect(runViaProgram(program, leafName, [], ['--json'])).rejects.toMatchObject({
      code: 'NETWORK',
      requestId: 'req_abc',
      message: expect.stringContaining('5000ms'),
    });
    // No stdout pollution — the action itself never printed; the
    // top-level emitError handler will print the envelope (we don't
    // exercise it here, but the shape contract is "action throws,
    // emitError prints once").
    expect(capture.stdout).toBe('');
  });
});
