/**
 * Component tests for `kash protocol userop {build,simulate,submit,hash,receipt,wait}`.
 *
 * Mocks `buildDirectClient`, then exercises each subcommand against
 * a stub SmartAccountClient. Verifies the cold-storage flow (build →
 * simulate → submit → wait) plus the file/stdin envelope reading +
 * bigint round-trip semantics.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

vi.mock('../../src/utils/direct-client.js', () => ({
  buildDirectClient: vi.fn(),
}));

const { buildDirectClient } = await import('../../src/utils/direct-client.js');
const { useropCommand } = await import('../../src/commands/protocol/userop.js');
const buildDirectClientMock = vi.mocked(buildDirectClient);

const MARKET = '0x1234567890abcdef1234567890abcdef12345678';
const SA = '0xfedcba0987654321fedcba0987654321fedcba09';
const TX_HASH = `0x${'a'.repeat(64)}` as const;
const USER_OP_HASH = `0x${'b'.repeat(64)}` as const;

function builtUserOp(): {
  userOp: {
    sender: `0x${string}`;
    nonce: bigint;
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    callData: `0x${string}`;
    signature: `0x${string}`;
  };
  userOpHash: `0x${string}`;
  typedData: { primaryType: string };
} {
  return {
    userOp: {
      sender: SA as `0x${string}`,
      nonce: 0n,
      callGasLimit: 100_000n,
      verificationGasLimit: 80_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      callData: '0xdeadbeef',
      signature: '0x',
    },
    userOpHash: USER_OP_HASH,
    typedData: { primaryType: 'PackedUserOperation' },
  };
}

function makeStubClient(): {
  trades: {
    prepareBuy: ReturnType<typeof vi.fn>;
    prepareSell: ReturnType<typeof vi.fn>;
    prepareClosePosition: ReturnType<typeof vi.fn>;
    prepareApprove: ReturnType<typeof vi.fn>;
    simulate: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    hashOf: ReturnType<typeof vi.fn>;
  };
  bundler: {
    getReceipt: ReturnType<typeof vi.fn>;
    waitForReceipt: ReturnType<typeof vi.fn>;
  };
} {
  return {
    trades: {
      prepareBuy: vi.fn(),
      prepareSell: vi.fn(),
      prepareClosePosition: vi.fn(),
      prepareApprove: vi.fn(),
      simulate: vi.fn(),
      submit: vi.fn(),
      hashOf: vi.fn(),
    },
    bundler: {
      getReceipt: vi.fn(),
      waitForReceipt: vi.fn(),
    },
  };
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kash-userop-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('kash protocol userop build buy', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('emits the populated UserOp envelope with bigints stringified', async () => {
    const client = makeStubClient();
    client.trades.prepareBuy.mockResolvedValue(builtUserOp());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(
      program,
      leafName,
      ['build', 'buy', MARKET, '-o', '0', '-a', '10'],
      ['--json']
    );

    expect(client.trades.prepareBuy).toHaveBeenCalledWith(
      MARKET,
      expect.objectContaining({
        account: SA,
        outcome: 0,
        amountUsdc: 10_000_000n,
        maxSlippageBps: 50,
      }),
      expect.objectContaining({ simulate: true })
    );

    const json = parseJsonStdout(capture) as {
      side: string;
      userOpHash: string;
      userOp: { sender: string; nonce: string; callGasLimit: string };
    };
    expect(json.side).toBe('buy');
    expect(json.userOpHash).toBe(USER_OP_HASH);
    expect(json.userOp.nonce).toBe('0');
    expect(json.userOp.callGasLimit).toBe('100000');
  });

  it('--out writes the envelope to a file at mode 0600', async () => {
    const client = makeStubClient();
    client.trades.prepareBuy.mockResolvedValue(builtUserOp());
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const outPath = join(workDir, 'op.json');
    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(program, leafName, [
      'build',
      'buy',
      MARKET,
      '-o',
      '0',
      '-a',
      '10',
      '--out',
      outPath,
    ]);

    const onDisk = JSON.parse(readFileSync(outPath, 'utf8')) as {
      side: string;
      userOp: { nonce: string };
    };
    expect(onDisk.side).toBe('buy');
    expect(onDisk.userOp.nonce).toBe('0');
  });
});

describe('kash protocol userop simulate', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('parses an envelope file and forwards to client.trades.simulate', async () => {
    const client = makeStubClient();
    client.trades.simulate.mockResolvedValue({ willSucceed: true, gasEstimate: 500_000n });
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    // Write a UserOp envelope to disk first.
    const envelopePath = join(workDir, 'op.json');
    const envelope = {
      side: 'buy',
      target: MARKET,
      userOp: {
        sender: SA,
        nonce: '0',
        callGasLimit: '100000',
        verificationGasLimit: '80000',
        preVerificationGas: '50000',
        maxFeePerGas: '5000000000',
        maxPriorityFeePerGas: '1000000000',
        callData: '0xdeadbeef',
        signature: '0x',
      },
      userOpHash: USER_OP_HASH,
    };
    writeFileSync(envelopePath, JSON.stringify(envelope));

    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(program, leafName, ['simulate', envelopePath], ['--json']);

    // simulate() should receive the bigint-decoded UserOp.
    const call = client.trades.simulate.mock.calls[0]![0] as { nonce: bigint; sender: string };
    expect(call.sender).toBe(SA);
    expect(typeof call.nonce).toBe('bigint');
    expect(call.nonce).toBe(0n);

    const json = parseJsonStdout(capture) as { willSucceed: boolean; gasEstimate?: string };
    expect(json.willSucceed).toBe(true);
    expect(json.gasEstimate).toBe('500000');
  });

  it('emits revert details when simulate returns willSucceed: false', async () => {
    const client = makeStubClient();
    client.trades.simulate.mockResolvedValue({
      willSucceed: false,
      revertReason: 'OutcomeNotTradable',
      decodedError: { name: 'OutcomeNotTradable', args: [] as readonly unknown[] },
    });
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const envelopePath = join(workDir, 'op.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: '0x',
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(program, leafName, ['simulate', envelopePath], ['--json']);

    const json = parseJsonStdout(capture) as {
      willSucceed: boolean;
      revertReason: string;
      decodedError: { name: string };
    };
    expect(json.willSucceed).toBe(false);
    expect(json.revertReason).toBe('OutcomeNotTradable');
    expect(json.decodedError.name).toBe('OutcomeNotTradable');
  });
});

describe('kash protocol userop hash', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('returns the recomputed hash as a single value', async () => {
    const client = makeStubClient();
    client.trades.hashOf.mockReturnValue(USER_OP_HASH);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const envelopePath = join(workDir, 'op.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '5',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: '0x',
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(program, leafName, ['hash', envelopePath], ['--json']);

    const json = parseJsonStdout(capture) as { userOpHash: string };
    expect(json.userOpHash).toBe(USER_OP_HASH);
    expect(client.trades.hashOf).toHaveBeenCalledWith(
      expect.objectContaining({ sender: SA, nonce: 5n })
    );
  });
});

describe('kash protocol userop submit', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('refuses an envelope whose signature is empty (0x)', async () => {
    const envelopePath = join(workDir, 'op.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: '0x',
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await expect(runViaProgram(program, leafName, ['submit', envelopePath])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('refuses a signature that is too short to be a valid ECDSA sig', async () => {
    // 64 hex chars instead of the canonical 130 — a common truncation
    // mistake when copying signatures from a hardware-wallet display.
    const envelopePath = join(workDir, 'truncated.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: `0x${'a'.repeat(64)}`,
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await expect(runViaProgram(program, leafName, ['submit', envelopePath])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('refuses a non-hex signature', async () => {
    const envelopePath = join(workDir, 'badhex.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          // Looks-like-base64 — not 0x-hex. Should fail the shape check.
          signature: 'MEUCIQDYwxXBxxxXBYxxxBxxxBxxxBxxxBxxxBxxxBxxxBxxxBxxxBxxxBxxxBx',
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await expect(runViaProgram(program, leafName, ['submit', envelopePath])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('submits a signed envelope and emits userOpHash in JSON', async () => {
    const client = makeStubClient();
    client.trades.submit.mockResolvedValue({ userOpHash: USER_OP_HASH });
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const envelopePath = join(workDir, 'signed.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: `0x${'a'.repeat(130)}`, // mock 65-byte signature
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(program, leafName, ['submit', envelopePath], ['--json']);

    expect(client.trades.submit).toHaveBeenCalledWith(
      expect.objectContaining({ sender: SA }),
      expect.objectContaining({ skipStalenessCheck: false })
    );

    const json = parseJsonStdout(capture) as { userOpHash: string; waited: boolean };
    expect(json.userOpHash).toBe(USER_OP_HASH);
    expect(json.waited).toBe(false);
  });

  it('--wait calls bundler.waitForReceipt after submit', async () => {
    const client = makeStubClient();
    client.trades.submit.mockResolvedValue({ userOpHash: USER_OP_HASH });
    client.bundler.waitForReceipt.mockResolvedValue({
      userOpHash: USER_OP_HASH,
      sender: SA,
      nonce: '0x0',
      success: true,
      actualGasCost: '0x1',
      actualGasUsed: '0x2',
      receipt: {
        transactionHash: TX_HASH,
        blockNumber: '0x1234',
        status: '0x1',
      },
    });
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const envelopePath = join(workDir, 'signed.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: `0x${'a'.repeat(130)}`,
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(program, leafName, ['submit', envelopePath, '--wait'], ['--json']);

    expect(client.bundler.waitForReceipt).toHaveBeenCalledWith(USER_OP_HASH, {});
    const json = parseJsonStdout(capture) as { success: boolean; userOpHash: string };
    expect(json.success).toBe(true);
    expect(json.userOpHash).toBe(USER_OP_HASH);
  });

  // Partial-completion guard: when submit succeeds but the wait
  // phase fails (timeout, transient bundler error), the userOpHash
  // is on the bundler queue and the operator can resume via
  // `kash protocol userop wait <hash>`. The CLI surfaces the hash
  // before rethrowing so that information isn't lost.
  it('--wait surfaces userOpHash partial record when waitForReceipt rejects', async () => {
    const client = makeStubClient();
    client.trades.submit.mockResolvedValue({ userOpHash: USER_OP_HASH });
    const bundlerTimeout = Object.assign(new Error('timed out waiting for UserOp'), {
      name: 'KashBundlerError',
      code: 'BUNDLER_RECEIPT_TIMEOUT',
      context: { userOpHash: USER_OP_HASH, timeoutMs: 60_000 },
    });
    client.bundler.waitForReceipt.mockRejectedValue(bundlerTimeout);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const envelopePath = join(workDir, 'signed-partial.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: `0x${'a'.repeat(130)}`,
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await expect(
      runViaProgram(program, leafName, ['submit', envelopePath, '--wait'], ['--json'])
    ).rejects.toBeDefined();

    // The submit returned the hash, then wait threw. The CLI emits
    // the partial-completion record on stdout BEFORE rethrowing.
    const partial = parseJsonStdout(capture) as {
      userOpHash: string;
      waited: boolean;
      partial: boolean;
    };
    expect(partial.userOpHash).toBe(USER_OP_HASH);
    expect(partial.waited).toBe(false);
    expect(partial.partial).toBe(true);
  });

  it('--wait surfaces resume-command on stderr when waitForReceipt rejects (human mode)', async () => {
    const client = makeStubClient();
    client.trades.submit.mockResolvedValue({ userOpHash: USER_OP_HASH });
    client.bundler.waitForReceipt.mockRejectedValue(new Error('bundler unreachable'));
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const envelopePath = join(workDir, 'signed-partial-human.json');
    writeFileSync(
      envelopePath,
      JSON.stringify({
        userOp: {
          sender: SA,
          nonce: '0',
          callGasLimit: '100000',
          verificationGasLimit: '80000',
          preVerificationGas: '50000',
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '1000000000',
          callData: '0xdeadbeef',
          signature: `0x${'a'.repeat(130)}`,
        },
      })
    );

    const { program, leafName } = wrapInProgram(useropCommand);
    await expect(
      runViaProgram(program, leafName, ['submit', envelopePath, '--wait'])
    ).rejects.toBeDefined();

    expect(capture.stderr).toContain(USER_OP_HASH);
    expect(capture.stderr).toContain('kash protocol userop wait');
  });
});

describe('kash protocol userop receipt', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
    buildDirectClientMock.mockReset();
  });
  afterEach(() => teardown());

  it('emits null in JSON mode when the receipt is not yet available', async () => {
    const client = makeStubClient();
    client.bundler.getReceipt.mockResolvedValue(null);
    buildDirectClientMock.mockResolvedValue({
      client: client as never,
      chainId: 8453,
      smartAccount: SA as `0x${string}`,
    });

    const { program, leafName } = wrapInProgram(useropCommand);
    await runViaProgram(program, leafName, ['receipt', USER_OP_HASH], ['--json']);

    expect(capture.stdout.trim()).toBe('null');
  });

  it('rejects malformed hash with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(useropCommand);
    await expect(
      runViaProgram(program, leafName, ['receipt', '0xnot-a-hash'])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
