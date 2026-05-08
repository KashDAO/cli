/**
 * Global option resolution.
 *
 * Commander 13 makes the root program's options available on every
 * subcommand via `cmd.optsWithGlobals()`. This helper centralises the
 * shape so command modules type their access to it once.
 *
 * The flags fall into three buckets:
 *
 *   1. **Output controls** — `--json`, `--quiet`, `--no-color`, `--debug`.
 *      Drive how output and traces are rendered.
 *   2. **Config selection** — `--profile`, `--config`. Decide which
 *      credentials get loaded.
 *   3. **SDK overrides** — `--base-url`, `--max-retries`, `--timeout-ms`.
 *      Per-invocation overrides for the SDK config; useful for CI
 *      matrix builds and ad-hoc staging tests.
 */

import { CliValidationError } from '../errors.js';

import { parseFieldsList } from './fields.js';
import { parseFilter, type FilterAst } from './filter.js';

import type { Command } from 'commander';

export type GlobalOptions = {
  /** `--json` — emit machine-readable JSON instead of human output. */
  readonly json: boolean;
  /** `--quiet` — suppress informational human-mode output. */
  readonly quiet: boolean;
  /** `--no-color` — disable ANSI escapes (also honors `NO_COLOR`). */
  readonly noColor: boolean;
  /** `--debug` — emit SDK lifecycle traces (request/response/retry/error) to stderr. */
  readonly debug: boolean;
  /** `--profile <name>` — pick a named profile from `~/.kash/config.json`. */
  readonly profile: string | undefined;
  /** `--config <path>` — explicit config file path; overrides default + env. */
  readonly configPath: string | undefined;
  /** `--base-url <url>` — override the API base URL for this invocation. */
  readonly baseUrl: string | undefined;
  /** `--max-retries <n>` — override SDK retry budget for this invocation. */
  readonly maxRetries: number | undefined;
  /** `--timeout-ms <n>` — override SDK request timeout for this invocation. */
  readonly timeoutMs: number | undefined;
  /**
   * `--api-version <date>` — pin against a public-API contract date.
   * The value is sent as `X-Kash-Api-Version` on every request. The
   * server runs a version-appropriate code path; sending an
   * unrecognised date returns `410 API_VERSION_UNSUPPORTED`. Omit
   * (or `undefined`) → server uses its canonical `PUBLIC_API_VERSION`.
   */
  readonly apiVersion: string | undefined;
  /**
   * `--fields <list>` — gh-style projection on `--json` output. Parsed
   * into dot-segmented paths; `undefined` when the flag was not passed
   * (commands then emit the full payload).
   */
  readonly fields: ReadonlyArray<readonly string[]> | undefined;
  /**
   * `--filter <expr>` — boolean DSL applied before `--fields`
   * projection. Filters list/get-style payloads to entries matching
   * the predicate. `undefined` when the flag was not passed.
   */
  readonly filter: FilterAst | undefined;
};

type RawGlobalOptions = {
  json?: boolean;
  quiet?: boolean;
  // Commander stores `--no-color` as `{ color: false }` — the default for a
  // `--no-X` boolean is `true`, so the explicit `false` means "disabled."
  color?: boolean;
  debug?: boolean;
  profile?: string;
  config?: string;
  baseUrl?: string;
  maxRetries?: string;
  timeoutMs?: string;
  apiVersion?: string;
  fields?: string;
  filter?: string;
};

/**
 * Pull the globals from the active command. Falls back to defaults
 * for any flag the user did not pass. Validates numeric inputs with
 * structured errors (so an agent gets a `INVALID_INPUT` code, not a
 * cryptic NaN cascade).
 */
export function readGlobals(cmd: Command): GlobalOptions {
  const opts = cmd.optsWithGlobals<RawGlobalOptions>();
  return {
    json: opts.json === true,
    quiet: opts.quiet === true,
    noColor: opts.color === false,
    // `KASH_DEBUG=1` (or any truthy value) mirrors `--debug`. Common
    // case: CI matrix configs and parent processes that can't easily
    // edit the invocation. Explicit `--debug` always wins (a user can
    // force it on even when the env says off).
    debug: opts.debug === true || isTruthyEnv(process.env['KASH_DEBUG']),
    profile: opts.profile,
    configPath: opts.config,
    baseUrl: opts.baseUrl === undefined ? undefined : parseUrl(opts.baseUrl, 'base-url'),
    maxRetries:
      opts.maxRetries === undefined
        ? undefined
        : // Cap at 10 to match the SDK's `kashClientConfigSchema`
          // (`maxRetries: z.number().int().min(0).max(10)`). Bouncing
          // out-of-range values here gives the agent an `INVALID_INPUT`
          // with a clear field, instead of a cryptic SDK
          // `KashConfigurationError` after the client tries to construct.
          parseBoundedUnsigned(opts.maxRetries, 'max-retries', 0, 10),
    timeoutMs:
      opts.timeoutMs === undefined ? undefined : parsePositive(opts.timeoutMs, 'timeout-ms'),
    // `--api-version` is forwarded to the SDK as `apiVersion`. Format
    // validation (`YYYY-MM-DD`) is enforced by the SDK's
    // `kashClientConfigSchema`. We don't pre-validate here — letting
    // the SDK be the single source of truth keeps the format rule in
    // one place. A malformed value surfaces as
    // `KashConfigurationError` from client construction, which the
    // CLI's error mapper converts to a structured envelope.
    apiVersion: opts.apiVersion,
    fields: opts.fields === undefined ? undefined : parseFieldsList(opts.fields),
    filter: opts.filter === undefined ? undefined : parseFilter(opts.filter),
  };
}

function parseBoundedUnsigned(raw: string, name: string, min: number, max: number): number {
  // Same strict-shape rationale as `parsePositiveInt`: reject decimals
  // and scientific notation BEFORE `parseInt`'s silent precision loss
  // (`1.5 → 1`, `1e3 → 1`). Bounded numeric flags like `--max-retries`
  // shouldn't accept either form.
  if (!/^\+?\d+$/.test(raw)) {
    throw new CliValidationError(
      `--${name} must be an integer between ${String(min)} and ${String(max)}.`,
      `Got "${raw}". Pass digits only — no decimals or scientific notation.`,
      name
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new CliValidationError(
      `--${name} must be an integer between ${String(min)} and ${String(max)}.`,
      `Got "${raw}".`,
      name
    );
  }
  return n;
}

function parseUrl(raw: string, name: string): string {
  let url: URL;
  try {
    // `new URL()` catches "no scheme", "no host", "malformed escape",
    // etc. — but it's permissive about the scheme. `file:`, `data:`,
    // `javascript:`, `about:` all parse cleanly. For an HTTP API
    // base URL, restricting to http/https is the right invariant
    // (defence-in-depth: even if the SDK forwards the URL to fetch
    // and refuses non-http schemes, we surface the error with a
    // clear field name).
    url = new URL(raw);
  } catch {
    throw new CliValidationError(
      `--${name} must be a valid URL.`,
      `Got "${raw}". Include the scheme, e.g. https://api.kash.bot/v1.`,
      name
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliValidationError(
      `--${name} must use http:// or https:// (got "${url.protocol}").`,
      `Schemes like file:, data:, javascript:, and about: are rejected — they would either silently fail in the SDK or open an attack vector.`,
      name
    );
  }
  return raw;
}

/**
 * Parse a CLI flag value as a strictly positive integer.
 *
 * Throws a structured `CliValidationError` (with a `check_input`
 * action naming the bad field) so an AI agent gets `INVALID_INPUT`
 * with a concrete recovery hint instead of a NaN cascade.
 *
 * Exported because every command that takes a positive-integer flag
 * (`--limit`, `--timeout`, `--poll-interval`, …) routes through it
 * — keeps validation messages and error envelopes uniform.
 */
export function parsePositiveInt(raw: string, name: string): number {
  // `Number.parseInt('1.5', 10)` returns 1 and `Number.parseInt('1e3', 10)`
  // returns 1 — both are silent precision losses for what looks like
  // a typo. Reject the raw shape first (bare digits only, optional
  // leading +) so the user sees an explicit error instead of a value
  // they didn't type.
  if (!/^\+?\d+$/.test(raw)) {
    throw new CliValidationError(
      `--${name} must be a positive integer.`,
      `Got "${raw}". Pass digits only — no decimals, scientific notation, or sign except a leading +.`,
      name
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliValidationError(
      `--${name} must be a positive integer.`,
      `Got "${raw}". Pass an integer > 0.`,
      name
    );
  }
  return n;
}

// Internal alias kept so the existing call sites in this file don't
// need to change. New consumers should import `parsePositiveInt`.
const parsePositive = parsePositiveInt;

/**
 * Optional variant of {@link parsePositiveInt}. Returns `undefined`
 * when the flag is absent (the common "default to SDK behaviour"
 * pattern); otherwise validates and returns the integer.
 *
 * Hoisted from per-command copies so flag wording, bounds, and
 * envelope shape stay uniform across `--wait-timeout-ms`,
 * `--poll-interval-ms`, etc.
 */
export function parseOptionalPositiveInt(
  raw: string | undefined,
  name: string
): number | undefined {
  return raw === undefined ? undefined : parsePositiveInt(raw, name);
}

/**
 * Positive-finite-float variant of {@link parsePositiveInt}. Used by
 * gas-percentile flags and similar continuous-quantity bounds where
 * an integer-only parser would surprise operators (e.g.
 * `--max-tip-gwei 1.5`).
 */
export function parsePositiveFloat(raw: string, name: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliValidationError(
      `--${name} must be a positive number.`,
      `Got "${raw}". Pass a finite number > 0.`,
      name
    );
  }
  return n;
}

/** Optional variant of {@link parsePositiveFloat}. */
export function parseOptionalPositiveFloat(
  raw: string | undefined,
  name: string
): number | undefined {
  return raw === undefined ? undefined : parsePositiveFloat(raw, name);
}

/**
 * Recognise truthy env values the way every other tool does: `1`,
 * `true`, `yes`, `on` (case-insensitive). Empty string and `0` are
 * falsy. Anything else is a no-op rather than an error — env
 * pollution is common and shouldn't fail builds.
 */
function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
