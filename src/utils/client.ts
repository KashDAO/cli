/**
 * Build a `KashClient` from the resolved CLI configuration plus
 * per-invocation global flag overrides.
 *
 * Centralised here so command modules don't each have to know how to
 * read config, surface "missing API key" errors, or thread base URLs.
 * Every command that hits `api.kash.bot` must pass `requireAuth: true`
 * so a missing API key fails fast at the call site with a structured
 * `CliError` pointing the user at `kash auth set-key`. Only the offline
 * commands (`kash explain`, `kash --version`, `kash --help`) and the
 * `kash health` probe construct a client without `requireAuth`.
 *
 * Three layers feed the final SDK config:
 *
 *   1. The active profile + env vars (resolved by config-store).
 *   2. Per-invocation `--profile` / `--config` overrides (which select
 *      *which* profile and file feed step 1).
 *   3. Per-invocation `--base-url` / `--max-retries` / `--timeout-ms`
 *      flags, which override the SDK's runtime config directly.
 *
 * `--debug` wires a stderr-emitting hook into the SDK's lifecycle so
 * a developer or AI agent can see request/response/retry/error
 * traces without instrumenting the SDK.
 */

import { KashClient, type KashClientHooks } from '@kashdao/sdk';

import { CliError, EXIT_CODES } from '../errors.js';
import { CLI_VERSION } from '../version.js';

import { readConfig, type ResolvedConfig } from './config-store.js';
import { style } from './output.js';

import type { GlobalOptions } from './global-options.js';

export type ClientOptions = {
  /** When true, throw `CliError` if no API key is configured. */
  readonly requireAuth?: boolean;
  /**
   * Global flags from the root program. Optional so internal callers
   * (and tests) can build a client without going through Commander.
   */
  readonly globals?: GlobalOptions;
};

export type BuiltClient = {
  readonly client: KashClient;
  readonly config: ResolvedConfig;
};

export async function buildClient(opts: ClientOptions = {}): Promise<BuiltClient> {
  const globals = opts.globals;
  const config = await readConfig({
    ...(globals?.profile === undefined ? {} : { profile: globals.profile }),
    ...(globals?.configPath === undefined ? {} : { configPath: globals.configPath }),
  });

  if (opts.requireAuth && !config.apiKey) {
    throw new CliError('No API key configured.', {
      code: 'AUTH_REQUIRED',
      exitCode: EXIT_CODES.AUTH,
      suggestion:
        "First-time setup: run 'kash setup' (interactive wizard). Otherwise: 'kash auth set-key' or set KASH_API_KEY.",
    });
  }

  // Per-invocation overrides win over the resolved profile+env config.
  const baseUrl = globals?.baseUrl ?? config.baseUrl;

  const client = new KashClient({
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    baseUrl,
    ...(globals?.maxRetries === undefined ? {} : { maxRetries: globals.maxRetries }),
    ...(globals?.timeoutMs === undefined ? {} : { timeoutMs: globals.timeoutMs }),
    // Forward the public-API contract pin from `--api-version` (or
    // `KASH_API_VERSION` env, if a future iteration plumbs it). The
    // SDK validates the date format and sends the value as the
    // `X-Kash-Api-Version` request header; the public-api routes the
    // request through a version-appropriate code path.
    ...(globals?.apiVersion === undefined ? {} : { apiVersion: globals.apiVersion }),
    userAgentSuffix: `kash-cli/${CLI_VERSION}`,
    ...(globals?.debug === true ? { hooks: buildDebugHooks(globals.json) } : {}),
  });

  return { client, config };
}

/**
 * Build SDK lifecycle hooks that emit traces to stderr.
 *
 * In `--debug --json` mode each event is a one-line JSON record so an
 * AI agent can stream-parse them. In human mode they're a compact
 * prefix plus method/path/status — close to what an HTTP client like
 * `curl -v` would surface, but at the SDK boundary so retries are
 * visible.
 *
 * Quiet mode silences nothing here: `--debug` is opt-in and the user
 * who passed it wants to see traces, full stop.
 */
function buildDebugHooks(json: boolean): KashClientHooks {
  // Use stderr directly rather than the `log` helpers because the
  // hooks fire synchronously inside the SDK and we want zero overhead
  // in the common case (no quiet check, no chalk wrapping).
  const emit = (record: Record<string, unknown>): void => {
    if (json) {
      process.stderr.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const { event, method, url, status, attempt, durationMs, reason, delayMs, code } = record;
    const prefix = style.dim('[debug]');
    const path = typeof url === 'string' ? url : '';
    const tag = String(event);
    if (event === 'request') {
      process.stderr.write(
        `${prefix} ${tag} ${String(method)} ${path} (attempt ${String(attempt)})\n`
      );
    } else if (event === 'response') {
      process.stderr.write(
        `${prefix} ${tag} ${String(status)} ${String(method)} ${path} ${String(durationMs)}ms\n`
      );
    } else if (event === 'retry') {
      process.stderr.write(
        `${prefix} ${tag} ${String(method)} ${path} reason=${String(reason)} delay=${String(delayMs)}ms\n`
      );
    } else if (event === 'error') {
      process.stderr.write(
        `${prefix} ${tag} ${String(code)} ${String(method)} ${path} ${String(status ?? '-')} ${String(durationMs)}ms\n`
      );
    }
  };

  return {
    onRequest: (event) => {
      emit({
        event: 'request',
        method: event.method,
        url: event.url,
        attempt: event.attempt,
        idempotencyKey: event.idempotencyKey ?? null,
      });
    },
    onResponse: (event) => {
      emit({
        event: 'response',
        method: event.method,
        url: event.url,
        attempt: event.attempt,
        status: event.status,
        durationMs: event.durationMs,
        requestId: event.requestId ?? null,
      });
    },
    onRetry: (event) => {
      emit({
        event: 'retry',
        method: event.method,
        url: event.url,
        attempt: event.attempt,
        reason: event.reason,
        delayMs: event.delayMs,
      });
    },
    onError: (event) => {
      emit({
        event: 'error',
        method: event.method,
        url: event.url,
        attempt: event.attempt,
        status: event.status ?? null,
        code: event.code,
        durationMs: event.durationMs,
      });
    },
  };
}
