/**
 * Component tests for the offline `kash protocol` utility helpers:
 *   - `protocol token-id` — pure arithmetic, no RPC.
 *   - `protocol decode-revert` — selector-based ABI lookup, no RPC.
 *
 * Both call into `@kashdao/protocol-sdk` directly without going
 * through `buildDirectClient`, so they need no profile config and
 * are safe to test end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

const { decodeRevertCommand } = await import('../../src/commands/protocol/decode-revert.js');
const { tokenIdCommand } = await import('../../src/commands/protocol/token-id.js');

describe('kash protocol token-id', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });
  afterEach(() => teardown());

  it('computes the canonical (marketId << 8) | outcomeIndex encoding', async () => {
    const { program, leafName } = wrapInProgram(tokenIdCommand);
    await runViaProgram(program, leafName, ['--market-id', '42', '--outcome', '0'], ['--json']);
    const json = parseJsonStdout(capture) as { tokenId: string; tokenIdHex: string };
    // 42 << 8 = 10752 = 0x2a00; outcome 0 contributes nothing.
    expect(json.tokenId).toBe('10752');
    expect(json.tokenIdHex).toBe('0x2a00');
  });

  it('handles outcome index up to 255', async () => {
    const { program, leafName } = wrapInProgram(tokenIdCommand);
    await runViaProgram(program, leafName, ['--market-id', '1', '--outcome', '255'], ['--json']);
    const json = parseJsonStdout(capture) as { tokenId: string };
    // 1 << 8 = 256 + 255 = 511.
    expect(json.tokenId).toBe('511');
  });

  it('accepts 0x-hex marketId input', async () => {
    const { program, leafName } = wrapInProgram(tokenIdCommand);
    await runViaProgram(program, leafName, ['--market-id', '0xff', '--outcome', '0'], ['--json']);
    const json = parseJsonStdout(capture) as { marketId: string; tokenId: string };
    expect(json.marketId).toBe('255');
    expect(json.tokenId).toBe('65280'); // 255 << 8
  });

  it('rejects negative marketId with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(tokenIdCommand);
    await expect(
      runViaProgram(program, leafName, ['--market-id', '-1', '--outcome', '0'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects out-of-range outcome with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(tokenIdCommand);
    await expect(
      runViaProgram(program, leafName, ['--market-id', '0', '--outcome', '256'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects malformed marketId with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(tokenIdCommand);
    await expect(
      runViaProgram(program, leafName, ['--market-id', 'not-a-number', '--outcome', '0'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('kash protocol decode-revert', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });
  afterEach(() => teardown());

  it('decodes a Panic(uint256) revert via the EntryPoint ABI fallback', async () => {
    // 0x4e487b71 = Panic(uint256); the trailing arg is the panic code (0x11 = arithmetic overflow).
    const data = '0x4e487b710000000000000000000000000000000000000000000000000000000000000011';
    const { program, leafName } = wrapInProgram(decodeRevertCommand);
    await runViaProgram(program, leafName, [data], ['--json']);
    const json = parseJsonStdout(capture) as { name: string; args: unknown[] };
    expect(json.name).toBe('Panic');
    expect(json.args).toHaveLength(1);
  });

  it('returns null in JSON mode when the selector is unknown', async () => {
    // 0xdeadbeef is not a known selector in either ABI.
    const data = '0xdeadbeef00000000000000000000000000000000000000000000000000000000';
    const { program, leafName } = wrapInProgram(decodeRevertCommand);
    await runViaProgram(program, leafName, [data], ['--json']);
    const stdout = capture.stdout.trim();
    expect(stdout).toBe('null');
  });

  it('rejects non-hex input with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(decodeRevertCommand);
    await expect(runViaProgram(program, leafName, ['not hex'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects too-short input (no full 4-byte selector)', async () => {
    const { program, leafName } = wrapInProgram(decodeRevertCommand);
    await expect(runViaProgram(program, leafName, ['0x12'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
