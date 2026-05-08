/**
 * Component test harness.
 *
 * Component tests exercise full Commander commands with the SDK
 * mocked at the boundary. They assert:
 *
 *   - the command parses argv correctly,
 *   - the right SDK method is called with the right shape,
 *   - the rendered stdout/stderr matches expectations (JSON envelope
 *     in --json mode; human prose otherwise),
 *   - errors map to the right exit codes and CliError codes.
 *
 * The harness:
 *
 *   - swaps a stub `KashClient` into `buildClient` via vi.mock,
 *   - captures stdout/stderr writes,
 *   - configures the output module to a known state per test,
 *   - exposes helpers to invoke a command with argv and grab results.
 */

import { Command } from 'commander';
import { vi, type Mock } from 'vitest';

import { readGlobals } from '../../src/utils/global-options.js';
import { configureOutput } from '../../src/utils/output.js';

/** Captured writer output. Cleared between runs. */
export type Capture = {
  stdout: string;
  stderr: string;
};

/**
 * Wrap a leaf command in a temporary root program that registers the
 * same global flags the real binary exposes. Required so leaf
 * commands can read `optsWithGlobals` for `--json` / `--quiet` /
 * `--profile` / etc. without the test having to drive the entire
 * binary entry point.
 *
 * Returns the wrapping program plus a leaf-level handle to its argv
 * driver — pass argv to `program.parseAsync`, prefix with `[leafName,
 * ...argv]` so Commander dispatches into the leaf.
 */
export function wrapInProgram(leaf: Command): { program: Command; leafName: string } {
  const program = new Command()
    .name('kash')
    .exitOverride() // Don't process.exit on errors — let the test see them.
    .option('--json', '', false)
    .option('--quiet', '', false)
    .option('--no-color', '')
    .option('--debug', '', false)
    .option('-p, --profile <name>')
    .option('--config <path>')
    .option('--base-url <url>')
    .option('--max-retries <n>')
    .option('--timeout-ms <n>')
    .option('--fields <list>')
    .option('--filter <expr>')
    // Mirror the real binary's preAction hook so `configureOutput`
    // sees the resolved `--quiet`/`--no-color`/`--fields`/`--filter`
    // flags. Without this, tests that pass these flags would fall
    // back to whatever `configureOutput` was set to in the test's
    // beforeEach — which means flag-handling regressions wouldn't be
    // caught.
    .hook('preAction', (thisCommand) => {
      const globals = readGlobals(thisCommand);
      configureOutput({
        quiet: globals.quiet,
        noColor: globals.noColor,
        fields: globals.fields,
        filter: globals.filter,
      });
    });
  program.addCommand(leaf);
  return { program, leafName: leaf.name() };
}

/**
 * Wire stdout/stderr capture and output-module state for a single
 * test. Call from `beforeEach`. Returns the capture object that fills
 * up as the command runs, plus a teardown function.
 */
export function captureStreams(): { capture: Capture; restore: () => void } {
  const capture: Capture = { stdout: '', stderr: '' };
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    capture.stdout += String(chunk);
    return true;
  });
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    capture.stderr += String(chunk);
    return true;
  });
  return {
    capture,
    restore: () => {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    },
  };
}

/**
 * Stub of `KashClient` with all sub-clients mocked. Tests configure
 * the relevant methods via `mockClient.<resource>.<method>.mockResolvedValueOnce(...)`.
 */
export function makeMockClient(): {
  markets: { list: Mock; get: Mock; predictions: Mock };
  quotes: { buy: Mock; sell: Mock };
  trades: { create: Mock; confirm: Mock; get: Mock; list: Mock; waitForCompletion: Mock };
  traces: { get: Mock };
  portfolio: { get: Mock; positions: Mock };
  account: { usage: Mock };
  webhooks: {
    list: Mock;
    redeliver: Mock;
    rotateSecret: Mock;
    verifySignature: Mock;
    constructEvent: Mock;
  };
  healthCheck: Mock;
} {
  return {
    markets: {
      list: vi.fn(),
      get: vi.fn(),
      predictions: vi.fn(),
    },
    quotes: {
      buy: vi.fn(),
      sell: vi.fn(),
    },
    trades: {
      create: vi.fn(),
      confirm: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      waitForCompletion: vi.fn(),
    },
    traces: {
      get: vi.fn(),
    },
    portfolio: {
      get: vi.fn(),
      positions: vi.fn(),
    },
    account: {
      usage: vi.fn(),
    },
    webhooks: {
      list: vi.fn(),
      redeliver: vi.fn(),
      rotateSecret: vi.fn(),
      verifySignature: vi.fn(),
      constructEvent: vi.fn(),
    },
    healthCheck: vi.fn(),
  };
}

/**
 * Parse the captured stdout as JSON. Throws with the original output
 * attached if the parse fails, so test failures are diagnosable.
 */
export function parseJsonStdout(capture: Capture): unknown {
  const trimmed = capture.stdout.trim();
  if (!trimmed) throw new Error('No stdout captured (expected JSON)');
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    throw new Error(
      `Captured stdout is not JSON:\n${capture.stdout}\nParse error: ${(cause as Error).message}`
    );
  }
}

/** Drive a Commander command; returns when it resolves or throws. */
export async function runCommand(
  cmd: { parseAsync(argv: string[], opts: { from: 'user' }): Promise<unknown> },
  argv: string[]
): Promise<void> {
  await cmd.parseAsync(argv, { from: 'user' });
}

/**
 * Drive a leaf command via its temporary root program (built by
 * `wrapInProgram`). Threads global flags so `optsWithGlobals` works
 * the same way it does in the real binary.
 *
 * Pass argv as the user would type it after `kash`, e.g.
 *   `runViaProgram(program, leafName, ['list', '--json'])`
 * — the harness prepends the leaf name automatically so callers can
 * keep the leaf-level focus.
 */
export async function runViaProgram(
  program: Command,
  leafName: string,
  argv: string[],
  globalArgv: readonly string[] = []
): Promise<void> {
  await program.parseAsync([...globalArgv, leafName, ...argv], { from: 'user' });
}
