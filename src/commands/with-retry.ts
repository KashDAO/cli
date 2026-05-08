/**
 * `kash with-retry [opts] -- <command> [args...]` — wrap any kash
 * command in a retry loop driven by the structured error envelope.
 *
 * **Why a built-in.** The `examples/trade-replay.sh` recipe shows the
 * pattern, but every agent / CI script ends up reimplementing it
 * slightly differently. Promoting it to a first-class command means:
 *   - Idempotency-key handling is consistent (the inner command's
 *     own --auto-idempotency-key / --idempotency-key still applies;
 *     retries are at the CLI-invocation level so the inner command's
 *     guarantees stay intact).
 *   - `recoverable`/`retryAfterMs` from the error envelope drive the
 *     wait — same logic that powers the SDK's own retries, surfaced
 *     to scripts.
 *
 * **Mechanics.** Spawns the same kash binary as a child process,
 * forwards stdout/stderr live (so the user sees progress), and
 * captures stderr to parse the `CliErrorEnvelope` when the inner
 * command fails. If the inner command emitted `--json`, we get
 * structured `code` / `recoverable` / `retryAfterMs` and use them.
 * Otherwise we fall back to a fixed exponential schedule.
 *
 * Bare success (exit 0) returns immediately. Non-recoverable failure
 * also returns immediately — there's no point retrying an
 * `INVALID_INPUT` or `AUTH_REQUIRED`. Recoverable failure
 * (`RATE_LIMITED`, `NETWORK`, `TIMEOUT`, `MAINTENANCE`, `SERVER_ERROR`)
 * triggers the next attempt up to `--max-attempts`.
 */

import { spawn } from 'node:child_process';

import { Command } from 'commander';

import { CliError, toCliError } from '../errors.js';
import { parsePositiveInt, readGlobals } from '../utils/global-options.js';
import { log, style } from '../utils/output.js';

type WithRetryOptions = {
  maxAttempts?: string;
  initialDelayMs?: string;
  maxDelayMs?: string;
  retryWithoutJson?: boolean;
};

/** Codes whose envelopes are worth retrying. Mirrors the SDK's policy. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMITED',
  'NETWORK',
  'TIMEOUT',
  'MAINTENANCE',
  'SERVER_ERROR',
]);

/** Codes that are explicitly NOT worth retrying — fail fast. */
const TERMINAL_CODES: ReadonlySet<string> = new Set([
  'INVALID_INPUT',
  'AUTH_REQUIRED',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'CONFLICT',
  'CONFIGURATION',
  'DIRECT_CONFIG_MISSING',
  'SIGNER_FAILED',
]);

export const withRetryCommand = new Command('with-retry')
  .description('Re-run a kash command on recoverable failures (rate limits, transient errors).')
  .option('--max-attempts <n>', 'maximum total attempts including the first (default 5)', '5')
  .option(
    '--initial-delay-ms <n>',
    'starting backoff when the envelope has no retryAfterMs (default 1000)',
    '1000'
  )
  .option('--max-delay-ms <n>', 'cap on the per-attempt wait (default 30000)', '30000')
  .option(
    '--retry-without-json',
    'retry even when the inner command did not emit --json (no envelope to discriminate ' +
      'terminal from transient — opt in if you trust the inner command failed transiently)'
  )
  // Allow unknown options to flow through as positional args so the
  // wrapped command's flags don't get parsed by Commander as our own.
  .allowUnknownOption()
  .argument('<command...>', 'kash command + args; pass after `--` to disambiguate')
  .addHelpText(
    'after',
    `
Examples:
  $ kash with-retry --max-attempts 5 -- markets list --status ACTIVE --json
  $ kash with-retry -- trade buy <id> --outcome 0 --amount 10 \\
        --auto-idempotency-key --json --quiet
  $ kash with-retry --max-attempts 3 -- health --json --quiet

Notes:
  - The wrapped command MUST come after \`--\` so its flags don't collide
    with with-retry's own.
  - When the wrapped command emits --json, the error envelope's
    \`code\` / \`recoverable\` / \`retryAfterMs\` drive the retry. Recoverable
    codes (RATE_LIMITED, NETWORK, TIMEOUT, MAINTENANCE, SERVER_ERROR)
    retry; terminal codes (INVALID_INPUT, AUTH_REQUIRED, NOT_FOUND, …)
    fail fast.
  - Without --json on the inner command, we DO NOT retry by default —
    no envelope means we can't tell INVALID_INPUT from a transient
    NETWORK error, and retrying validation 5× wastes time. Pass
    --retry-without-json to force exponential backoff regardless.
`
  )
  .action(async (commandArgs: string[], options: WithRetryOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    const maxAttempts = options.maxAttempts
      ? parsePositiveInt(options.maxAttempts, 'max-attempts')
      : 5;
    const initialDelay = options.initialDelayMs
      ? parsePositiveInt(options.initialDelayMs, 'initial-delay-ms')
      : 1_000;
    const maxDelay = options.maxDelayMs
      ? parsePositiveInt(options.maxDelayMs, 'max-delay-ms')
      : 30_000;

    if (commandArgs.length === 0) {
      throw new CliError('with-retry needs a command to run.', {
        code: 'INVALID_INPUT',
        recoverable: true,
        suggestion:
          'Pass the kash command after `--`, e.g. `kash with-retry -- health --json --quiet`.',
      });
    }

    try {
      await runWithRetry(commandArgs, {
        maxAttempts,
        initialDelay,
        maxDelay,
        humanMode: !globals.json,
        retryWithoutJson: options.retryWithoutJson === true,
      });
    } catch (cause) {
      throw toCliError(cause);
    }
  });

type RunOptions = {
  readonly maxAttempts: number;
  readonly initialDelay: number;
  readonly maxDelay: number;
  readonly humanMode: boolean;
  readonly retryWithoutJson: boolean;
};

async function runWithRetry(args: readonly string[], opts: RunOptions): Promise<void> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const result = await runOnce(args);

    if (result.exitCode === 0) {
      // Success — replay captured stdout (stderr was already streamed
      // live by runOnce). The inner command's JSON / table output is
      // what the user wants on the success path.
      if (result.stdout) process.stdout.write(result.stdout);
      process.exit(0);
    }

    // Non-zero exit — the JSON error envelope (if --json was set on
    // the inner command) lives on stdout. Fall back to stderr for
    // commands that route errors that way.
    const envelope = parseErrorEnvelope(result.stdout) ?? parseErrorEnvelope(result.stderr);
    const code = envelope?.error.code;
    const recoverable = decideRetry(code, envelope?.error.recoverable, {
      retryWithoutJson: opts.retryWithoutJson,
    });

    if (!recoverable || attempt === opts.maxAttempts) {
      // Final attempt failed (or non-recoverable). Replay captured
      // stdout — that's where the JSON envelope lives in --json mode
      // and any successful prefix lives in human mode. Stderr already
      // streamed live during the attempt, so don't double-print it.
      if (result.stdout) process.stdout.write(result.stdout);
      if (opts.humanMode) {
        const reason = !recoverable ? 'non-recoverable error' : 'max attempts exhausted';
        log.error(`with-retry: ${reason} after attempt ${String(attempt)} (${code ?? 'unknown'}).`);
      }
      process.exit(result.exitCode);
    }

    // Recoverable — compute wait and retry. Drop the inner output
    // for failed-but-retried attempts so the user only sees the
    // final outcome.
    const wait = computeWait(envelope?.error.retryAfterMs, attempt, opts);
    if (opts.humanMode) {
      process.stderr.write(
        `${style.dim(
          `with-retry: attempt ${String(attempt)}/${String(opts.maxAttempts)} failed (${code ?? 'unknown'}); retrying in ${String(wait)}ms…`
        )}\n`
      );
    }
    await sleep(wait);
  }
}

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Spawn the kash CLI as a child process. Captures both stdout and
 * stderr — stdout because that's where the JSON error envelope lives
 * (via `printJson`); stderr because human-mode error rendering goes
 * there. We replay the captured streams to the user only after the
 * retry decision is made, to avoid showing transient failures.
 */
async function runOnce(args: readonly string[]): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    // process.argv[1] points at `dist/index.js` (or the published
    // bin's entry). Re-invoking via `process.execPath` avoids relying
    // on the shell `kash` lookup, which may not be on PATH for the
    // child (e.g. when `kash` was invoked via npx).
    const node = process.execPath;
    const entry = process.argv[1];
    if (!entry) {
      reject(new Error('with-retry: cannot determine kash entry path.'));
      return;
    }

    const child = spawn(node, [entry, ...args], {
      // stdin: 'ignore' (NOT 'inherit'). With inherit, an inner
      // command that prompts for input (`kash auth set-key` without
      // --from-stdin, an interactive `kash setup`) would silently
      // hang on retry — the prompt waits for input but the parent's
      // stdin has already been consumed (or is non-interactive in
      // the CI case). A retry loop should never be holding an
      // interactive prompt; if the inner command needs stdin, the
      // user runs it directly. `kash with-retry` is for commands
      // that read auth/config from env or pre-set state.
      // stdout + stderr stay piped so we can capture and re-emit.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Inherit env so the child sees KASH_API_KEY, KASH_PROFILE, etc.
      env: process.env,
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      // Stream stderr through live too — the inner command's progress
      // logs (spinners, retries) shouldn't get held back. The final
      // envelope at the very end is what we'll re-parse.
      process.stderr.write(text);
    });

    child.on('error', (err) => reject(err));
    child.on('exit', (exitCode, signal) => {
      // A signal-killed child gets exitCode null. Map to a non-zero
      // sentinel so the retry loop treats it as a failure.
      const code = exitCode ?? (signal === null ? 1 : 128);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * Look for a `CliErrorEnvelope` in the captured stderr. Robust to
 * non-JSON stderr (e.g. interleaved log lines) — scans for the last
 * line that parses as JSON with the `{ ok: false, error: { code } }`
 * shape.
 */
export function parseErrorEnvelope(
  stderr: string
): { error: { code: string; recoverable?: boolean; retryAfterMs?: number } } | undefined {
  // Search from the end backwards — the envelope is emitted last.
  const lines = stderr.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error?: unknown }).error === 'object'
      ) {
        const error = (
          parsed as { error: { code?: unknown; recoverable?: unknown; retryAfterMs?: unknown } }
        ).error;
        if (typeof error.code === 'string') {
          return {
            error: {
              code: error.code,
              ...(typeof error.recoverable === 'boolean' ? { recoverable: error.recoverable } : {}),
              ...(typeof error.retryAfterMs === 'number'
                ? { retryAfterMs: error.retryAfterMs }
                : {}),
            },
          };
        }
      }
    } catch {
      // Not JSON — skip.
    }
  }
  // The envelope is also commonly pretty-printed across multiple lines.
  // Try parsing the entire stderr as JSON if the multi-line scan fails.
  const trimmed = stderr.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { code?: unknown; recoverable?: unknown; retryAfterMs?: unknown };
      };
      if (parsed.error && typeof parsed.error.code === 'string') {
        return {
          error: {
            code: parsed.error.code,
            ...(typeof parsed.error.recoverable === 'boolean'
              ? { recoverable: parsed.error.recoverable }
              : {}),
            ...(typeof parsed.error.retryAfterMs === 'number'
              ? { retryAfterMs: parsed.error.retryAfterMs }
              : {}),
          },
        };
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Decide whether to retry based on the envelope. Sources of truth, in
 * order:
 *   1. Explicit allow-list of retryable codes — wins.
 *   2. Explicit deny-list of terminal codes — fails fast.
 *   3. The envelope's own `recoverable: boolean` — fallback for codes
 *      we don't have a strong opinion about.
 *   4. No envelope at all (non-JSON inner command, or stdout that
 *      doesn't parse) — DO NOT retry by default. Without an envelope
 *      we can't tell INVALID_INPUT (terminal) from a transient
 *      NETWORK timeout, and retrying validation errors 5× wastes
 *      time and confuses operators. Users who want unconditional
 *      retries can pass `--retry-without-json`.
 *
 * The "no-envelope = no-retry" default is the safe one. The previous
 * behaviour (assume-retryable) caused `with-retry -- trade buy <bad-id>
 * --outcome 0 --amount 10` to retry 5× on INVALID_INPUT — observable
 * confusion in the wild.
 */
export function decideRetry(
  code: string | undefined,
  envelopeRecoverable: boolean | undefined,
  options: { retryWithoutJson: boolean } = { retryWithoutJson: false }
): boolean {
  if (code === undefined) {
    // No envelope. Caller's policy wins.
    return options.retryWithoutJson;
  }
  if (RETRYABLE_CODES.has(code)) return true;
  if (TERMINAL_CODES.has(code)) return false;
  return envelopeRecoverable ?? true;
}

/**
 * Wait time for the next attempt. Server-driven `retryAfterMs` wins;
 * otherwise exponential (initial * 2^(attempt-1), capped at maxDelay).
 */
export function computeWait(
  retryAfterMs: number | undefined,
  attempt: number,
  opts: { initialDelay: number; maxDelay: number }
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, opts.maxDelay);
  }
  const exp = opts.initialDelay * 2 ** (attempt - 1);
  return Math.min(exp, opts.maxDelay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
