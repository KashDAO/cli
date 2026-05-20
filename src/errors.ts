/**
 * CLI error hierarchy + SDK-error mapper.
 *
 * The CliError shape is **the contract** between this CLI and any
 * agent or script that consumes it. The fields below are SemVer-stable
 * — additions are minor bumps, removals/renames are major bumps.
 *
 * Exit code convention:
 *   0  — success
 *   1  — generic error (validation, server, network, etc.)
 *   2  — auth failure (missing/invalid API key, missing scope)
 *
 * Mapping a `KashRateLimitError` to exit 1 is deliberate: a rate-limit
 * is recoverable, but the CLI should still fail loudly so scripts
 * don't silently move on. The `recoverable` boolean and `retryAfterMs`
 * field tell agents how to handle it.
 *
 * The `actions` array is the agent-friendly recovery path. Each entry
 * is one of a small, well-defined set of variants — agents can branch
 * on `actions[0].type` without parsing prose.
 *
 * **Catalog as source of truth.** Static fields (`recoverable`,
 * `docsUrl`, base `actions`) are read from
 * `error-catalog.ts#ERROR_CATALOG` based on the error's `code`, so
 * `kash explain RATE_LIMITED` always shows the same metadata as the
 * envelope on a real `RATE_LIMITED` failure. The `toCliError` mapper
 * adds runtime-only data (`retryAfterMs` from the server's
 * `Retry-After`, an extra `wait_and_retry` action derived from it).
 * Callers can override any field explicitly, but the default path
 * pulls from the catalog so drift is structurally impossible.
 */

import {
  KashAbortedError,
  KashAuthenticationError,
  KashAuthorizationError,
  KashConfigurationError as SdkKashConfigurationError,
  KashConflictError,
  KashError,
  KashMaintenanceError,
  KashNetworkError,
  KashNotFoundError,
  KashRateLimitError,
  KashServerError,
  KashTimeoutError,
  KashValidationError,
} from '@kashdao/sdk';

import { lookupErrorCodeWithFallback } from './error-catalog.js';

/** Exit codes used by the CLI. */
export const EXIT_CODES = {
  OK: 0,
  GENERIC: 1,
  AUTH: 2,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Machine-readable next-step hint. Agents inspect `type` and act
 * without parsing the human-prose `suggestion`. Adding new variants
 * is a minor bump (agents that don't recognise them ignore them);
 * removing or renaming is a major bump.
 *
 * **Templates.** A `run_command` action MAY carry `template: true` to
 * signal that `command` contains `<placeholder>` substrings that the
 * agent must substitute (or skip) before executing. Templates exist
 * because the static error catalog can't always know the concrete
 * command id / trade id / market id at the point the catalog is
 * authored — they're carved at runtime when the SDK error is mapped.
 * Agents that auto-execute `run_command` actions MUST honour the
 * `template` flag: substitute, prompt, or skip. Treating templated
 * commands as concrete will literally shell `kash trade status <id>`
 * (with the angle brackets) and fail.
 */
export type CliErrorAction =
  | {
      readonly type: 'run_command';
      readonly command: string;
      readonly description: string;
      /**
       * `true` when `command` contains `<placeholder>` tokens the
       * caller must substitute. Absent or `false` means the command
       * is concrete and safe to auto-execute. Agents that lack
       * substitution support should skip templated commands and fall
       * back to the catalog's `description` / `suggestion`.
       */
      readonly template?: boolean;
    }
  | { readonly type: 'set_env'; readonly variable: string; readonly description: string }
  | { readonly type: 'wait_and_retry'; readonly delayMs: number; readonly description: string }
  | { readonly type: 'open_url'; readonly url: string; readonly description: string }
  | { readonly type: 'check_input'; readonly field: string; readonly description: string };

export type CliErrorOptions = {
  readonly code: string;
  readonly suggestion?: string | undefined;
  readonly exitCode?: ExitCode;
  readonly requestId?: string | undefined;
  /**
   * Override the catalog's `recoverable`. If omitted the catalog's
   * value is used; if the code isn't in the catalog, defaults to
   * `false` via the UNEXPECTED fallback.
   */
  readonly recoverable?: boolean;
  /** Suggested delay before retrying. No catalog default. */
  readonly retryAfterMs?: number | undefined;
  /** Override the catalog's `docsUrl`. */
  readonly docsUrl?: string | undefined;
  /**
   * Additional `actions` to append to the catalog's static set. Use
   * this for runtime-derived hints (e.g. a `wait_and_retry` with the
   * server's exact Retry-After). Pass `actionsOverride` to replace
   * the catalog set entirely.
   */
  readonly actions?: readonly CliErrorAction[];
  /**
   * Replace the catalog's `actions` entirely (instead of appending
   * via `actions`). Use sparingly — the catalog is the source of
   * truth for static actions.
   */
  readonly actionsOverride?: readonly CliErrorAction[];
  readonly cause?: unknown;
};

export class CliError extends Error {
  readonly code: string;
  readonly suggestion: string | undefined;
  readonly exitCode: ExitCode;
  readonly requestId: string | undefined;
  /** True iff a sensible retry/recovery path exists. */
  readonly recoverable: boolean;
  /** Suggested delay before retrying (rate limit, server error). */
  readonly retryAfterMs: number | undefined;
  /** Stable docs URL agents can fetch for richer context. */
  readonly docsUrl: string | undefined;
  /** Machine-readable next-step hints. Empty array if none. */
  readonly actions: readonly CliErrorAction[];
  override readonly cause: unknown;

  constructor(message: string, options: CliErrorOptions) {
    super(message);
    this.name = 'CliError';
    const catalogEntry = lookupErrorCodeWithFallback(options.code);
    this.code = options.code;
    this.suggestion = options.suggestion;
    this.exitCode = options.exitCode ?? EXIT_CODES.GENERIC;
    this.requestId = options.requestId;
    this.recoverable = options.recoverable ?? catalogEntry.recoverable;
    this.retryAfterMs = options.retryAfterMs;
    this.docsUrl = options.docsUrl ?? catalogEntry.docsUrl;
    if (options.actionsOverride !== undefined) {
      this.actions = options.actionsOverride;
    } else {
      // Caller-provided actions first (they're contextually specific:
      // a `wait_and_retry` derived from the server's actual
      // Retry-After, or a `check_input` naming a concrete bad field),
      // catalog actions second (generic fallbacks). Agents act on the
      // first applicable hint, so the more specific one needs to win.
      this.actions = [...(options.actions ?? []), ...catalogEntry.actions];
    }
    this.cause = options.cause;
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * Render the error as the stable JSON envelope agents pin to. Kept
   * as a method so the index.ts emitError can serialise consistently
   * regardless of caller.
   */
  toEnvelope(): Record<string, unknown> {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        recoverable: this.recoverable,
        ...(this.suggestion === undefined ? {} : { suggestion: this.suggestion }),
        ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
        ...(this.docsUrl === undefined ? {} : { docsUrl: this.docsUrl }),
        ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
        actions: this.actions,
      },
    };
  }
}

export class CliValidationError extends CliError {
  constructor(message: string, suggestion?: string, field?: string) {
    super(message, {
      code: 'INVALID_INPUT',
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(field === undefined
        ? {}
        : {
            actions: [
              {
                type: 'check_input' as const,
                field,
                description: `Verify the value of "${field}".`,
              },
            ],
          }),
    });
    this.name = 'CliValidationError';
  }
}

export class CliConfigurationError extends CliError {
  constructor(message: string, suggestion?: string) {
    super(message, {
      code: 'CONFIGURATION',
      ...(suggestion === undefined ? {} : { suggestion }),
    });
    this.name = 'CliConfigurationError';
  }
}

/**
 * Translate any `unknown` error coming out of the SDK or the CLI
 * itself into a `CliError`. Pass-through for existing `CliError`
 * instances so callers can re-throw without re-wrapping.
 *
 * Each branch only sets runtime fields (suggestion, requestId,
 * retryAfterMs, runtime-derived actions). Static fields like
 * `recoverable`, `docsUrl`, and base `actions` come from the catalog
 * via the CliError constructor.
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) {
    return err;
  }
  // Commander-thrown errors (we call `program.exitOverride()` so
  // unknown commands / unknown options surface here instead of
  // exiting via process.exit). Help and version short-circuits also
  // come through — they're not errors and exit cleanly.
  const commander = mapCommanderError(err);
  if (commander) return commander;
  if (err instanceof KashAuthenticationError) {
    return new CliError(err.message, {
      code: 'AUTH_REQUIRED',
      exitCode: EXIT_CODES.AUTH,
      suggestion:
        "First-time setup: run 'kash setup' (interactive wizard). Otherwise: 'kash auth set-key' or set KASH_API_KEY.",
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashAuthorizationError) {
    return new CliError(err.message, {
      code: 'INSUFFICIENT_SCOPE',
      exitCode: EXIT_CODES.AUTH,
      suggestion:
        'The API key is valid but is missing the scope this command needs. Issue a key with broader scope via the Kash dashboard.',
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashRateLimitError) {
    const retrySec = err.retryAfterSeconds;
    const retryAfterMs = retrySec === undefined ? undefined : retrySec * 1000;
    const suggestion =
      retrySec !== undefined
        ? `Retry in ${String(retrySec)}s. Upgrade for higher limits: https://kash.bot/pricing`
        : 'Slow down request rate. Upgrade for higher limits: https://kash.bot/pricing';
    return new CliError(err.message, {
      code: 'RATE_LIMITED',
      suggestion,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(retryAfterMs === undefined
        ? {}
        : {
            actions: [
              {
                type: 'wait_and_retry' as const,
                delayMs: retryAfterMs,
                description: `Wait ${String(retrySec)}s then re-run the same command.`,
              },
            ],
          }),
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashNotFoundError) {
    return new CliError(err.message, {
      code: 'NOT_FOUND',
      suggestion: 'Double-check the resource id (markets and trades use UUIDs).',
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashConflictError) {
    return new CliError(err.message, {
      code: 'CONFLICT',
      suggestion:
        'A conflicting request is already in flight or the resource state changed underneath you. Inspect the trade with `kash trade status <id>` before retrying.',
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashValidationError) {
    return new CliError(err.message, {
      code: 'INVALID_INPUT',
      suggestion: 'Verify the request shape matches `kash <command> --help`.',
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashMaintenanceError) {
    const retrySec = err.retryAfterSeconds;
    const retryAfterMs = retrySec === undefined ? undefined : retrySec * 1000;
    return new CliError(err.message, {
      code: 'MAINTENANCE',
      suggestion:
        'The Kash trade pipeline is temporarily disabled. Check https://status.kash.bot and retry shortly.',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(retryAfterMs === undefined
        ? {}
        : {
            actions: [
              {
                type: 'wait_and_retry' as const,
                delayMs: retryAfterMs,
                description: `Wait ${String(retrySec)}s before retrying.`,
              },
            ],
          }),
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashTimeoutError) {
    return new CliError(err.message, {
      code: 'TIMEOUT',
      suggestion:
        'The request exceeded the configured timeout. Retry, or pass --timeout-ms to raise the cap.',
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashNetworkError) {
    // Inspect the underlying cause for DNS-resolution failures so we
    // can route the user to the right recovery action. The most common
    // failure mode pre-mainnet-launch is "configured for production
    // but production isn't deployed yet" — point them at staging via
    // their test key rather than a generic "check connectivity" line.
    const causeStr = `${String(err.message ?? '')} ${String((err.cause as Error)?.message ?? '')}`;
    const isDnsError =
      causeStr.includes('ENOTFOUND') ||
      causeStr.includes('getaddrinfo') ||
      causeStr.includes('EAI_AGAIN') ||
      causeStr.includes('Could not resolve');
    const suggestion = isDnsError
      ? 'The configured API host did not resolve in DNS. ' +
        'For staging, use a `kash_test_*` key — the CLI auto-routes to ' +
        '`https://api-staging.kash.bot/v1`. ' +
        'For a custom host, pass `--base-url <url>` or set `KASH_BASE_URL`. ' +
        'Production (`https://api.kash.bot/v1`) is not yet live; track launch ' +
        'status at https://docs.kash.bot.'
      : 'The request did not reach the API. Check network connectivity and retry.';
    return new CliError(err.message, {
      code: 'NETWORK',
      suggestion,
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashAbortedError) {
    return new CliError(err.message, {
      code: 'ABORTED',
      suggestion:
        'The request was cancelled before it completed. If the command is idempotent, you can safely retry with the same Idempotency-Key.',
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof KashServerError) {
    return new CliError(err.message, {
      code: 'SERVER_ERROR',
      suggestion:
        'The API returned a 5xx. The request is safe to retry. Status: https://status.kash.bot',
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof SdkKashConfigurationError) {
    // Surface the first Zod issue's path as a check_input action so
    // an agent can localise the broken field without parsing prose.
    const firstIssue = err.issues[0];
    const fieldPath = firstIssue?.path.join('.') ?? '';
    return new CliError(err.message, {
      code: 'CONFIGURATION',
      suggestion:
        firstIssue !== undefined
          ? `SDK rejected ${fieldPath || '(root)'}: ${firstIssue.message}`
          : 'The SDK rejected the configuration provided to the client.',
      ...(fieldPath
        ? {
            actions: [
              {
                type: 'check_input' as const,
                field: fieldPath,
                description: `Fix the value of "${fieldPath}" and re-run.`,
              },
            ],
          }
        : {}),
      cause: err,
    });
  }
  // ── Protocol-SDK (`@kashdao/protocol-sdk`) errors ───────────────
  // We don't eager-import the protocol-sdk just to use `instanceof`
  // checks (it pulls in viem). Duck-type on `err.name` instead — the
  // protocol-sdk's error classes set their `name` field deterministically
  // in the base constructor.
  const protocolErrorMapping = mapProtocolError(err);
  if (protocolErrorMapping !== undefined) {
    return protocolErrorMapping;
  }
  if (err instanceof KashError) {
    // Any KashError subclass we haven't enumerated above. Falls back
    // to the catalog's UNEXPECTED entry for `recoverable`/`docsUrl`
    // (so `kash explain` always returns *something*) but preserves
    // the SDK's `isRetryable` value.
    return new CliError(err.message, {
      code: 'UNEXPECTED',
      recoverable: err.isRetryable,
      ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new CliError(err.message, { code: 'UNEXPECTED', cause: err });
  }
  return new CliError(String(err), { code: 'UNEXPECTED', cause: err });
}

/**
 * Structural shape of Commander's `CommanderError`. Commander documents
 * `code` and `message` as stable public API and namespaces every code
 * with the `commander.` prefix (`commander.unknownCommand`,
 * `commander.help`, etc.).
 *
 * We type-guard against this shape rather than `instanceof CommanderError`
 * because importing the constructor here would force the Commander
 * module to load on the cold path even for invocations that never
 * touch it. Going through a structural check keeps the import lazy
 * AND keeps TypeScript safety at every use site.
 */
export type CommanderErrorLike = {
  readonly code: string;
  readonly message: string;
};

/**
 * Type guard — true iff `err` looks like a Commander-thrown error.
 * Commander always sets `code` to a string starting with `commander.`,
 * so the prefix check is the load-bearing test (filters out other
 * errors that happen to have a `code` field, e.g. `EACCES`).
 */
export function isCommanderError(err: unknown): err is CommanderErrorLike {
  if (!(err instanceof Error)) return false;
  const candidate = err as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('commander.') &&
    typeof candidate.message === 'string'
  );
}

/**
 * Map a Commander-thrown error to either a clean exit (help/version)
 * or a structured `CliError` (unknown command, unknown option, missing
 * argument, etc.). Returns undefined for non-Commander errors so the
 * outer mapper can keep walking its switch.
 */
function mapCommanderError(err: unknown): CliError | undefined {
  if (!isCommanderError(err)) return undefined;
  const { code, message } = err;

  // `commander.help`, `commander.helpDisplayed`, `commander.version` —
  // user asked for `--help` or `--version`. Commander already wrote
  // the output; surfacing this as a real error would be wrong. Use
  // `EXIT_CODES.OK` and code `'NOOP'` so the top-level boundary in
  // `index.ts` exits cleanly and prints nothing extra.
  if (
    code === 'commander.help' ||
    code === 'commander.helpDisplayed' ||
    code === 'commander.version'
  ) {
    return new CliError('', {
      code: 'NOOP',
      exitCode: EXIT_CODES.OK,
      recoverable: false,
      cause: err,
    });
  }

  // Unknown command — the most common typo case. Commander appends
  // a "Did you mean X?" suggestion to the message; we extract it so
  // the structured envelope carries a `run_command` recovery action
  // an agent can execute directly.
  if (code === 'commander.unknownCommand') {
    const match = /Did you mean (\S+?)\??\)?$/m.exec(message);
    const suggested = match?.[1];
    const suggestion = suggested
      ? `Did you mean \`kash ${suggested}\`? Run \`kash --help\` for the full command tree.`
      : 'Run `kash --help` for the full command tree.';
    return new CliError(stripTrailingNewlines(message), {
      code: 'INVALID_INPUT',
      recoverable: true,
      suggestion,
      ...(suggested === undefined
        ? {}
        : {
            actions: [
              {
                type: 'run_command' as const,
                command: `kash ${suggested}`,
                description: 'Run the suggested command instead.',
              },
            ],
          }),
      cause: err,
    });
  }

  // Unknown option — adjacent typo case. Commander doesn't always
  // include a suggestion for options; fall back to a generic check.
  if (code === 'commander.unknownOption') {
    return new CliError(stripTrailingNewlines(message), {
      code: 'INVALID_INPUT',
      recoverable: true,
      suggestion:
        'Run `kash <command> --help` for the supported flags, or `kash docs --json` for the full surface.',
      cause: err,
    });
  }

  // Missing required argument / option — Commander surfaces these
  // before the action runs. Keep the original message (it names the
  // flag) and add a generic check_input action.
  if (
    code === 'commander.missingArgument' ||
    code === 'commander.missingMandatoryOptionValue' ||
    code === 'commander.optionMissingArgument'
  ) {
    return new CliError(stripTrailingNewlines(message), {
      code: 'INVALID_INPUT',
      recoverable: true,
      suggestion: 'Run the command with `--help` to see required arguments.',
      cause: err,
    });
  }

  // Anything else from Commander (excess arguments, invalid choice,
  // etc.) — generic mapping with the original message preserved.
  return new CliError(stripTrailingNewlines(message), {
    code: 'INVALID_INPUT',
    recoverable: true,
    cause: err,
  });
}

/** Trim trailing newlines so error messages don't render double-spaced. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

/**
 * Map an `@kashdao/protocol-sdk` error to the corresponding CLI code,
 * by class name. Returns `undefined` if the error is not a recognised
 * protocol-sdk error.
 *
 * **Why duck-typing instead of `instanceof`?** Importing the
 * protocol-sdk eagerly here would defeat the cold-start optimisation
 * that lazy-loads `@kashdao/protocol-sdk` only when `kash protocol …`
 * commands run. Kash-orchestrated-only invocations (markets/trade/portfolio)
 * keep their fast path. The protocol-sdk's error base class sets
 * `name` to the constructor name in its constructor, so a name check
 * is reliable across module-instance boundaries.
 */
function mapProtocolError(err: unknown): CliError | undefined {
  if (!(err instanceof Error)) return undefined;
  switch (err.name) {
    case 'KashConfigError': {
      const cliErr = new CliError(err.message, {
        code: 'DIRECT_CONFIG_MISSING',
        suggestion:
          'Set the missing field via `kash config set <field> <value>` (rpcUrl, smartAccount, signerKeyRef, defaultChainId).',
        cause: err,
      });
      return cliErr;
    }
    case 'KashSignerError':
      return new CliError(err.message, {
        code: 'SIGNER_FAILED',
        suggestion: 'Verify the signerKeyRef target is readable (file:<path>) or set (env:<NAME>).',
        cause: err,
      });
    case 'KashChainError':
      return new CliError(err.message, {
        code: 'CHAIN_ERROR',
        suggestion: 'On-chain read or contract interaction failed unexpectedly.',
        cause: err,
      });
    case 'KashBundlerError':
      return new CliError(err.message, {
        code: 'BUNDLER_REJECTED',
        suggestion: 'Inspect the bundler-specific reason in the message and adjust.',
        cause: err,
      });
    case 'KashSimulationRevertedError':
      return new CliError(err.message, {
        code: 'TRANSACTION_REVERTED',
        suggestion: 'Re-run with `kash protocol simulate` to see the decoded revert reason.',
        cause: err,
      });
    case 'KashProtocolError':
      // Base class — ChainError is the closest fallback for any
      // protocol-sdk error not covered above.
      return new CliError(err.message, {
        code: 'CHAIN_ERROR',
        suggestion: 'Unrecognised protocol-sdk error. File an issue with `kash version --json`.',
        cause: err,
      });
    default:
      return undefined;
  }
}
