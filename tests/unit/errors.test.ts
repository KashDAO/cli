/**
 * Tests for the SDK→CliError mapper. The mapper is responsible for the
 * single most user-facing piece of the CLI: turning a transport error
 * into an exit code + suggestion the user can act on.
 */

import {
  KashAbortedError,
  KashAuthenticationError,
  KashAuthorizationError,
  KashConfigurationError as SdkKashConfigurationError,
  KashConflictError,
  KashMaintenanceError,
  KashNetworkError,
  KashNotFoundError,
  KashRateLimitError,
  KashServerError,
  KashTimeoutError,
  KashValidationError,
} from '@kashdao/sdk';
import { describe, expect, it } from 'vitest';

import {
  CliError,
  CliValidationError,
  EXIT_CODES,
  isCommanderError,
  toCliError,
} from '../../src/errors.js';

describe('toCliError', () => {
  it('passes through existing CliError instances unchanged', () => {
    const err = new CliError('boom', { code: 'TEST', exitCode: EXIT_CODES.GENERIC });
    expect(toCliError(err)).toBe(err);
  });

  it('maps KashAuthenticationError to exit code 2 with set-key suggestion', () => {
    const err = new KashAuthenticationError('bad key', {
      code: 'API_KEY_INVALID',
      statusCode: 401,
      requestId: 'req_1',
    });
    const result = toCliError(err);
    expect(result.code).toBe('AUTH_REQUIRED');
    expect(result.exitCode).toBe(EXIT_CODES.AUTH);
    expect(result.requestId).toBe('req_1');
    // The suggestion now leads with `kash setup` (first-run wizard)
    // and falls back to `kash auth set-key` for repeat configuration.
    expect(result.suggestion).toContain('kash setup');
    expect(result.suggestion).toContain('kash auth set-key');
  });

  it('maps KashAuthorizationError to exit code 2', () => {
    const err = new KashAuthorizationError('no scope', {
      code: 'INSUFFICIENT_SCOPE',
      statusCode: 403,
    });
    const result = toCliError(err);
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
    expect(result.exitCode).toBe(EXIT_CODES.AUTH);
  });

  it('maps KashRateLimitError and surfaces retry seconds', () => {
    const err = new KashRateLimitError('slow down', {
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      retryAfterSeconds: 30,
    });
    const result = toCliError(err);
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.suggestion).toContain('30s');
  });

  it('maps KashNotFoundError', () => {
    const err = new KashNotFoundError('nope', {
      code: 'MARKET_NOT_FOUND',
      statusCode: 404,
    });
    expect(toCliError(err).code).toBe('NOT_FOUND');
  });

  it('maps KashConflictError', () => {
    const err = new KashConflictError('idempotency conflict', {
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    });
    expect(toCliError(err).code).toBe('CONFLICT');
  });

  it('maps KashValidationError', () => {
    const err = new KashValidationError('bad input', {
      code: 'VALIDATION_FAILED',
      statusCode: 400,
    });
    expect(toCliError(err).code).toBe('INVALID_INPUT');
  });

  it('maps KashMaintenanceError to MAINTENANCE', () => {
    const err = new KashMaintenanceError('halted', {
      code: 'API_TRADE_PROCESSING_HALTED',
      statusCode: 503,
    });
    expect(toCliError(err).code).toBe('MAINTENANCE');
  });

  it('maps KashTimeoutError', () => {
    const err = new KashTimeoutError('timed out', { code: 'SDK_TIMEOUT' });
    expect(toCliError(err).code).toBe('TIMEOUT');
  });

  it('maps KashNetworkError', () => {
    const err = new KashNetworkError('econnrefused', { code: 'SDK_NETWORK' });
    expect(toCliError(err).code).toBe('NETWORK');
  });

  it('maps KashServerError', () => {
    const err = new KashServerError('5xx', {
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    });
    expect(toCliError(err).code).toBe('SERVER_ERROR');
  });

  it('wraps a plain Error as UNEXPECTED', () => {
    const err = new Error('something broke');
    const result = toCliError(err);
    expect(result.code).toBe('UNEXPECTED');
    expect(result.message).toBe('something broke');
  });

  it('coerces a non-Error value to UNEXPECTED', () => {
    const result = toCliError('plain string');
    expect(result.code).toBe('UNEXPECTED');
    expect(result.message).toBe('plain string');
  });

  describe('Commander error mapping', () => {
    /**
     * Build a synthetic `CommanderError` shape — type-guarded by
     * `isCommanderError` via the structural shape (Error +
     * `code: string` starting with `commander.`), so we don't need to
     * import Commander itself in the test.
     */
    function commanderError(code: string, message: string): Error {
      const e = new Error(message);
      (e as Error & { code?: string }).code = code;
      return e;
    }

    describe('isCommanderError type guard', () => {
      it('accepts a real-shape Commander error', () => {
        const err = commanderError('commander.unknownCommand', 'unknown command x');
        expect(isCommanderError(err)).toBe(true);
        if (isCommanderError(err)) {
          // Type narrowing — `code` and `message` are both strings now.
          const code: string = err.code;
          const message: string = err.message;
          expect(code).toBe('commander.unknownCommand');
          expect(message).toBe('unknown command x');
        }
      });

      it('rejects errors whose `code` does not start with `commander.`', () => {
        // EACCES, ENOENT, EPIPE — common Node error codes that share
        // the field name but mean something else entirely.
        for (const code of ['EACCES', 'ENOENT', 'EPIPE']) {
          const err = commanderError(code, 'msg');
          expect(isCommanderError(err)).toBe(false);
        }
      });

      it('rejects non-Error values (strings, plain objects, null)', () => {
        expect(isCommanderError('commander.help')).toBe(false);
        expect(isCommanderError({ code: 'commander.help', message: 'x' })).toBe(false);
        expect(isCommanderError(null)).toBe(false);
        expect(isCommanderError(undefined)).toBe(false);
      });

      it('rejects errors missing a `code` field', () => {
        expect(isCommanderError(new Error('plain'))).toBe(false);
      });

      it('rejects errors with non-string `code`', () => {
        const err = new Error('msg');
        (err as Error & { code?: number }).code = 42;
        expect(isCommanderError(err)).toBe(false);
      });
    });

    it('maps unknown command to INVALID_INPUT with a run_command suggestion', () => {
      const err = commanderError(
        'commander.unknownCommand',
        "error: unknown command 'mark'\n(Did you mean markets?)"
      );
      const result = toCliError(err);
      expect(result.code).toBe('INVALID_INPUT');
      expect(result.recoverable).toBe(true);
      expect(result.suggestion).toContain('kash markets');
      const runCmd = result.actions.find((a) => a.type === 'run_command');
      expect(runCmd).toBeDefined();
      if (runCmd && runCmd.type === 'run_command') {
        expect(runCmd.command).toBe('kash markets');
      }
    });

    it('maps unknown command without "Did you mean" to INVALID_INPUT (no run_command)', () => {
      const err = commanderError('commander.unknownCommand', "error: unknown command 'xyzzy'");
      const result = toCliError(err);
      expect(result.code).toBe('INVALID_INPUT');
      // No run_command action when there's no parsed suggestion.
      const runCmd = result.actions.find((a) => a.type === 'run_command');
      // Catalog defaults can include run_command actions; verify the
      // command isn't pointing at a parsed suggestion specifically.
      if (runCmd && runCmd.type === 'run_command') {
        expect(runCmd.command).not.toMatch(/^kash xyzzy/);
      }
    });

    it('maps unknown option to INVALID_INPUT', () => {
      const err = commanderError('commander.unknownOption', "error: unknown option '--bogus'");
      const result = toCliError(err);
      expect(result.code).toBe('INVALID_INPUT');
      expect(result.message).toContain('--bogus');
    });

    it('maps missing required argument to INVALID_INPUT', () => {
      const err = commanderError(
        'commander.missingArgument',
        "error: missing required argument 'marketId'"
      );
      const result = toCliError(err);
      expect(result.code).toBe('INVALID_INPUT');
    });

    it('maps `commander.help` to clean-exit NOOP (exitCode 0)', () => {
      const err = commanderError('commander.help', '');
      const result = toCliError(err);
      expect(result.code).toBe('NOOP');
      expect(result.exitCode).toBe(EXIT_CODES.OK);
    });

    it('maps `commander.version` to clean-exit NOOP (exitCode 0)', () => {
      const err = commanderError('commander.version', '0.1.0');
      const result = toCliError(err);
      expect(result.code).toBe('NOOP');
      expect(result.exitCode).toBe(EXIT_CODES.OK);
    });

    it('non-Commander Error with a `code` field passes through to UNEXPECTED', () => {
      // Defensive: a non-commander error with `code: 'EACCES'` should
      // NOT trip the commander mapper. The mapper requires the
      // `commander.` prefix.
      const err = commanderError('EACCES', 'permission denied');
      const result = toCliError(err);
      expect(result.code).toBe('UNEXPECTED');
    });
  });

  describe('agent-friendly metadata', () => {
    it('AUTH_REQUIRED carries set-key, set-env, and open-url actions', () => {
      const err = toCliError(
        new KashAuthenticationError('bad key', { code: 'API_KEY_INVALID', statusCode: 401 })
      );
      expect(err.recoverable).toBe(true);
      expect(err.docsUrl).toBe('https://kash.bot/docs/cli/authentication');
      // Assert the *set* of action types — the catalog's ordering is
      // an implementation detail, not part of the contract. The
      // load-bearing invariant is "every expected action is present."
      const types = err.actions.map((a) => a.type);
      expect(types).toEqual(expect.arrayContaining(['run_command', 'set_env', 'open_url']));
      expect(err.actions).toContainEqual(
        expect.objectContaining({ type: 'run_command', command: 'kash setup' })
      );
      expect(err.actions).toContainEqual(
        expect.objectContaining({ type: 'run_command', command: 'kash auth set-key' })
      );
      expect(err.actions).toContainEqual(
        expect.objectContaining({ type: 'set_env', variable: 'KASH_API_KEY' })
      );
    });

    it('RATE_LIMITED includes a wait_and_retry action with the parsed delay', () => {
      const err = toCliError(
        new KashRateLimitError('slow', {
          code: 'RATE_LIMIT_EXCEEDED',
          statusCode: 429,
          retryAfterSeconds: 30,
        })
      );
      expect(err.recoverable).toBe(true);
      expect(err.retryAfterMs).toBe(30_000);
      const wait = err.actions.find((a) => a.type === 'wait_and_retry');
      expect(wait).toMatchObject({ type: 'wait_and_retry', delayMs: 30_000 });
    });

    it('MAINTENANCE includes the status-page url even without retry-after', () => {
      const err = toCliError(
        new KashMaintenanceError('halted', { code: 'API_TRADE_PROCESSING_HALTED', statusCode: 503 })
      );
      expect(err.docsUrl).toBe('https://status.kash.bot');
      expect(err.actions.some((a) => a.type === 'open_url')).toBe(true);
    });

    it('toEnvelope produces the documented JSON shape', () => {
      const err = toCliError(
        new KashRateLimitError('slow', {
          code: 'RATE_LIMIT_EXCEEDED',
          statusCode: 429,
          retryAfterSeconds: 5,
          requestId: 'req_abc',
        })
      );
      const envelope = err.toEnvelope() as { ok: boolean; error: Record<string, unknown> };
      expect(envelope.ok).toBe(false);
      expect(envelope.error['code']).toBe('RATE_LIMITED');
      expect(envelope.error['recoverable']).toBe(true);
      expect(envelope.error['retryAfterMs']).toBe(5_000);
      expect(envelope.error['requestId']).toBe('req_abc');
      expect(envelope.error['actions']).toBeInstanceOf(Array);
    });

    it('CliValidationError places check_input first when a field is named', () => {
      // Caller-provided actions (the specific check_input) come
      // before the catalog's generic `kash <command> --help` action
      // so agents act on the most contextual hint.
      const err = new CliValidationError('bad amount', 'amount must be positive', 'amount');
      expect(err.actions[0]).toMatchObject({ type: 'check_input', field: 'amount' });
      // Catalog actions still follow.
      expect(err.actions.length).toBeGreaterThan(1);
    });

    it('non-Kash errors map to UNEXPECTED with the catalog action surfaced', () => {
      // Plain Errors map to UNEXPECTED. The catalog tells agents to
      // capture `kash version --json` for issue triage — even errors
      // we don't recognise still produce a usable next step.
      const err = toCliError(new Error('boom'));
      expect(err.code).toBe('UNEXPECTED');
      expect(err.recoverable).toBe(false);
      expect(err.actions).toEqual([
        {
          type: 'run_command',
          command: 'kash version --json',
          description: 'Capture runtime info to attach to the bug report.',
        },
      ]);
    });

    it('maps KashAbortedError to ABORTED with recoverable=false', () => {
      const err = toCliError(new KashAbortedError('cancelled', { code: 'SDK_ABORTED' }));
      expect(err.code).toBe('ABORTED');
      expect(err.recoverable).toBe(false);
      expect(err.docsUrl).toBe('https://kash.bot/docs/cli/troubleshooting');
    });

    it('maps the SDK KashConfigurationError to CONFIGURATION with a check_input action', () => {
      const err = toCliError(
        new SdkKashConfigurationError('bad config', {
          code: 'SDK_CONFIGURATION_INVALID',
          issues: [{ path: ['baseUrl'], message: 'must be a valid URL' }],
        })
      );
      expect(err.code).toBe('CONFIGURATION');
      expect(err.recoverable).toBe(true);
      expect(err.suggestion).toContain('baseUrl');
      expect(err.actions[0]).toMatchObject({ type: 'check_input', field: 'baseUrl' });
    });

    it('every CliError code is in the catalog (no orphan codes reach agents)', async () => {
      const { ERROR_CODES } = await import('../../src/error-catalog.js');
      // The mapper should never produce a code outside the catalog —
      // that would break `kash explain <code>` for agents.
      const producedCodes = [
        toCliError(new KashAuthenticationError('x', { code: 'API_KEY_INVALID', statusCode: 401 }))
          .code,
        toCliError(new KashAuthorizationError('x', { code: 'INSUFFICIENT_SCOPE', statusCode: 403 }))
          .code,
        toCliError(new KashRateLimitError('x', { code: 'RATE_LIMIT_EXCEEDED', statusCode: 429 }))
          .code,
        toCliError(new KashNotFoundError('x', { code: 'MARKET_NOT_FOUND', statusCode: 404 })).code,
        toCliError(new KashConflictError('x', { code: 'CONFLICT', statusCode: 409 })).code,
        toCliError(new KashValidationError('x', { code: 'VALIDATION_FAILED', statusCode: 400 }))
          .code,
        toCliError(
          new KashMaintenanceError('x', {
            code: 'API_TRADE_PROCESSING_HALTED',
            statusCode: 503,
          })
        ).code,
        toCliError(new KashTimeoutError('x', { code: 'SDK_TIMEOUT' })).code,
        toCliError(new KashNetworkError('x', { code: 'SDK_NETWORK' })).code,
        toCliError(new KashAbortedError('x', { code: 'SDK_ABORTED' })).code,
        toCliError(new KashServerError('x', { code: 'INTERNAL_ERROR', statusCode: 500 })).code,
        toCliError(new SdkKashConfigurationError('x', { code: 'SDK_CONFIGURATION_INVALID' })).code,
        toCliError(new Error('plain')).code,
      ];

      for (const code of producedCodes) {
        expect(ERROR_CODES.has(code)).toBe(true);
      }
    });
  });
});
