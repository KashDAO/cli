/**
 * Component tests for `kash webhooks verify`.
 *
 * Validates the input-resolution rules (--body vs --body-file,
 * --secret vs --secret-file vs KASH_WEBHOOK_SECRET) and the JSON
 * output contract. The actual HMAC math is the SDK's job — we mock
 * `verifySignature` here.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const { verifyWebhookCommand } = await import('../../src/commands/webhooks/verify.js');
const buildClientMock = vi.mocked(buildClient);

const originalEnv = { ...process.env };

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kash-webhook-verify-'));
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('kash webhooks verify', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    delete process.env['KASH_WEBHOOK_SECRET'];
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildClientMock.mockReset();
  });
  afterEach(() => {
    teardown();
    process.env = { ...originalEnv };
  });

  it('forwards --body and --secret to the SDK', async () => {
    const client = makeMockClient();
    client.webhooks.verifySignature.mockResolvedValue({ valid: true });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(verifyWebhookCommand);
    await runViaProgram(program, leafName, [
      '--signature',
      't=1,v1=abc',
      '--body',
      '{"hello":"world"}',
      '--secret',
      'whsec_topsecret',
    ]);

    expect(client.webhooks.verifySignature).toHaveBeenCalledWith(
      '{"hello":"world"}',
      't=1,v1=abc',
      'whsec_topsecret',
      {}
    );
    expect(capture.stdout).toContain('Signature is valid');
  });

  it('reads body from --body-file', async () => {
    const bodyPath = tmpFile('body.json', '{"event":"trade.completed"}');
    const client = makeMockClient();
    client.webhooks.verifySignature.mockResolvedValue({ valid: true });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(verifyWebhookCommand);
    await runViaProgram(program, leafName, [
      '--signature',
      't=1,v1=abc',
      '--body-file',
      bodyPath,
      '--secret',
      'whsec_topsecret',
    ]);

    expect(client.webhooks.verifySignature).toHaveBeenCalledWith(
      '{"event":"trade.completed"}',
      't=1,v1=abc',
      'whsec_topsecret',
      {}
    );
  });

  it('reads secret from --secret-file (trims trailing newline)', async () => {
    const secretPath = tmpFile('webhook.secret', 'whsec_fromfile\n');
    const client = makeMockClient();
    client.webhooks.verifySignature.mockResolvedValue({ valid: true });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(verifyWebhookCommand);
    await runViaProgram(program, leafName, [
      '--signature',
      't=1,v1=abc',
      '--body',
      '{}',
      '--secret-file',
      secretPath,
    ]);

    expect(client.webhooks.verifySignature).toHaveBeenCalledWith(
      '{}',
      't=1,v1=abc',
      'whsec_fromfile',
      {}
    );
  });

  it('falls back to KASH_WEBHOOK_SECRET env when no flag is passed', async () => {
    process.env['KASH_WEBHOOK_SECRET'] = 'whsec_fromenv';
    const client = makeMockClient();
    client.webhooks.verifySignature.mockResolvedValue({ valid: true });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(verifyWebhookCommand);
    await runViaProgram(program, leafName, ['--signature', 't=1,v1=abc', '--body', '{}']);

    expect(client.webhooks.verifySignature).toHaveBeenCalledWith(
      '{}',
      't=1,v1=abc',
      'whsec_fromenv',
      {}
    );
  });

  it('emits invalid result with the SDK reason in --json mode', async () => {
    const client = makeMockClient();
    client.webhooks.verifySignature.mockResolvedValue({
      valid: false,
      reason: 'Signature does not match the expected HMAC.',
    });
    buildClientMock.mockResolvedValue({ client: client as never, config: {} as never });

    const { program, leafName } = wrapInProgram(verifyWebhookCommand);
    await runViaProgram(
      program,
      leafName,
      ['--signature', 't=1,v1=bad', '--body', '{}', '--secret', 'whsec_x'],
      ['--json']
    );

    const json = parseJsonStdout(capture) as { valid: boolean; reason?: string };
    expect(json.valid).toBe(false);
    expect(json.reason).toContain('does not match');
  });

  it('rejects when both --body and --body-file are provided', async () => {
    const { program, leafName } = wrapInProgram(verifyWebhookCommand);
    await expect(
      runViaProgram(program, leafName, [
        '--signature',
        't=1,v1=abc',
        '--body',
        '{}',
        '--body-file',
        '/tmp/x',
        '--secret',
        'whsec_x',
      ])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects when no secret is provided anywhere', async () => {
    const { program, leafName } = wrapInProgram(verifyWebhookCommand);
    await expect(
      runViaProgram(program, leafName, ['--signature', 't=1,v1=abc', '--body', '{}'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
