/**
 * Component tests for `kash webhooks replay`.
 *
 * Mocks `globalThis.fetch` so we don't actually POST anywhere. Verifies:
 *   - the signature header format is `t=<ms>,v1=<hex>` (Stripe-style),
 *   - secret resolution: --secret > --secret-env, with env-var taking
 *     effect when only --secret-env is set,
 *   - body is read verbatim from file or stdin,
 *   - --target validates as URL with http/https scheme,
 *   - --timestamp-ms freezes the signature at a known time (used for
 *     replay-window testing on the receiver),
 *   - the final result envelope shape (status, ok, durationMs, body).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

const { computeSignatureHeader, replayWebhookCommand } =
  await import('../../src/commands/webhooks/replay.js');

const TARGET = 'http://localhost:3000/webhook';
const SECRET = 'whsec_test_aaaaaaaaaaaaaaaa';
const BODY = JSON.stringify({ id: 'evt_123', type: 'trade.executed' });

let workDir: string;
let originalFetch: typeof globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kash-webhook-replay-'));
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

function mockResponse(status = 200, body = ''): Response {
  return new Response(body, { status });
}

describe('computeSignatureHeader (pure helper)', () => {
  it('emits the canonical t=<ms>,v1=<hex> shape', () => {
    const header = computeSignatureHeader(BODY, SECRET, 1_700_000_000_000);
    expect(header).toMatch(/^t=1700000000000,v1=[0-9a-f]{64}$/);
  });

  it('matches the SDK signing algorithm: HMAC over `<ms>.<body>`', () => {
    // Independently compute the expected HMAC and compare. This pins
    // us to the SDK's `verifySignature` shape — diverging here would
    // break round-trips between this command and the receiver.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHmac('sha256', SECRET).update(`1700000000000.${BODY}`).digest('hex');
    expect(computeSignatureHeader(BODY, SECRET, 1_700_000_000_000)).toBe(
      `t=1700000000000,v1=${expected}`
    );
  });

  it('produces different signatures for different timestamps (replay-window guard)', () => {
    const a = computeSignatureHeader(BODY, SECRET, 1_700_000_000_000);
    const b = computeSignatureHeader(BODY, SECRET, 1_700_000_001_000);
    expect(a).not.toBe(b);
  });
});

describe('kash webhooks replay', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });

  afterEach(() => teardown());

  it('signs the body and POSTs to --target with the canonical header', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, '{"ok":true}'));

    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);

    const { program, leafName } = wrapInProgram(replayWebhookCommand);
    await runViaProgram(
      program,
      leafName,
      [bodyPath, '-t', TARGET, '-s', SECRET, '--timestamp-ms', '1700000000000'],
      ['--json']
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(TARGET);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(BODY);

    // Header should be the canonical Stripe-style signature.
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Kash-Signature']).toMatch(/^t=1700000000000,v1=[0-9a-f]{64}$/);

    const json = parseJsonStdout(capture) as {
      targetUrl: string;
      status: number;
      ok: boolean;
      headerName: string;
      headerValue: string;
    };
    expect(json.targetUrl).toBe(TARGET);
    expect(json.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.headerName).toBe('X-Kash-Signature');
    expect(json.headerValue).toMatch(/^t=1700000000000,v1=[0-9a-f]{64}$/);
  });

  it('reads the body from stdin when path is "-"', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200));

    // Stub stdin to yield BODY.
    const originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: (async function* () {
        yield Buffer.from(BODY);
      })(),
    });

    try {
      const { program, leafName } = wrapInProgram(replayWebhookCommand);
      await runViaProgram(program, leafName, ['-', '-t', TARGET, '-s', SECRET]);

      const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
      expect(init.body).toBe(BODY);
    } finally {
      Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin });
    }
  });

  it('honours --secret-env for production-flavoured testing', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200));
    process.env['KASH_TEST_WEBHOOK_SECRET'] = SECRET;

    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);

    try {
      const { program, leafName } = wrapInProgram(replayWebhookCommand);
      await runViaProgram(program, leafName, [
        bodyPath,
        '-t',
        TARGET,
        '--secret-env',
        'KASH_TEST_WEBHOOK_SECRET',
        '--timestamp-ms',
        '1700000000000',
      ]);

      // Signature should match what direct compute would produce.
      const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const expected = computeSignatureHeader(BODY, SECRET, 1_700_000_000_000);
      expect(headers['X-Kash-Signature']).toBe(expected);
    } finally {
      delete process.env['KASH_TEST_WEBHOOK_SECRET'];
    }
  });

  it('refuses when no secret is supplied (neither --secret nor --secret-env)', async () => {
    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);

    const { program, leafName } = wrapInProgram(replayWebhookCommand);
    await expect(runViaProgram(program, leafName, [bodyPath, '-t', TARGET])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses when --secret-env points at an unset variable', async () => {
    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);
    delete process.env['DEFINITELY_NOT_SET_SECRET'];

    const { program, leafName } = wrapInProgram(replayWebhookCommand);
    await expect(
      runViaProgram(program, leafName, [
        bodyPath,
        '-t',
        TARGET,
        '--secret-env',
        'DEFINITELY_NOT_SET_SECRET',
      ])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects malformed --target URL', async () => {
    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);

    const { program, leafName } = wrapInProgram(replayWebhookCommand);
    await expect(
      runViaProgram(program, leafName, [bodyPath, '-t', 'not-a-url', '-s', SECRET])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects --target with an unsupported scheme (e.g. ftp://)', async () => {
    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);

    const { program, leafName } = wrapInProgram(replayWebhookCommand);
    await expect(
      runViaProgram(program, leafName, [bodyPath, '-t', 'ftp://example.com/webhook', '-s', SECRET])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('exposes a non-2xx response in the envelope without throwing', async () => {
    fetchSpy.mockResolvedValue(mockResponse(401, '{"error":"bad signature"}'));

    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);

    const { program, leafName } = wrapInProgram(replayWebhookCommand);
    await runViaProgram(program, leafName, [bodyPath, '-t', TARGET, '-s', SECRET], ['--json']);

    const json = parseJsonStdout(capture) as { status: number; ok: boolean; responseBody: string };
    expect(json.status).toBe(401);
    expect(json.ok).toBe(false);
    expect(json.responseBody).toBe('{"error":"bad signature"}');
  });

  it('--signature-header overrides the header name', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200));

    const bodyPath = join(workDir, 'body.json');
    writeFileSync(bodyPath, BODY);

    const { program, leafName } = wrapInProgram(replayWebhookCommand);
    await runViaProgram(program, leafName, [
      bodyPath,
      '-t',
      TARGET,
      '-s',
      SECRET,
      '--signature-header',
      'X-Custom-Sig',
    ]);

    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Custom-Sig']).toBeDefined();
    expect(headers['X-Kash-Signature']).toBeUndefined();
  });
});
