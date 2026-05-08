/**
 * Centralised stdout/stderr writes for the CLI.
 *
 * `output` exposes both human-mode (`print`, `log.success`, …) and a
 * `json` writer that always goes to stdout for AI-agent integration
 * (`--json --quiet`). Quiet mode silences the human-mode writers but
 * leaves `json` and `error` alone — scripts still see structured
 * output and errors when they pass `--quiet`.
 *
 * All chalk usage funnels through `Style` so the global `--no-color`
 * flag (or NO_COLOR env var per https://no-color.org) takes effect
 * uniformly.
 */

import chalk, { type ChalkInstance } from 'chalk';

import { projectFields } from './fields.js';
import { applyFilter, type FilterAst } from './filter.js';

let quiet = false;
let noColor = false;
let fields: ReadonlyArray<readonly string[]> | undefined;
let filter: FilterAst | undefined;

/**
 * Cache chalk's auto-detected color level once at module load.
 * `configureOutput` flips between this value and `0` so a later call
 * with `noColor: false` actually restores color (instead of being a
 * no-op because the previous call set it to 0). Important for tests
 * that toggle `noColor` between cases.
 */
const ORIGINAL_CHALK_LEVEL = chalk.level;

/** Wire global flags once, at startup, from the resolved global options. */
export function configureOutput(opts: {
  quiet?: boolean;
  noColor?: boolean;
  fields?: ReadonlyArray<readonly string[]> | undefined;
  filter?: FilterAst | undefined;
}): void {
  quiet = opts.quiet ?? false;
  noColor = opts.noColor ?? false;
  // `fields` and `filter` are intentionally rebound on every call
  // (including undefined) so test setups that toggle them between
  // cases see the change. Same pattern as `quiet`/`noColor` above.
  fields = opts.fields;
  filter = opts.filter;
  if (noColor || process.env['NO_COLOR']) {
    chalk.level = 0;
  } else {
    chalk.level = ORIGINAL_CHALK_LEVEL;
  }
}

/** Lightweight chalk wrapper that respects `--no-color`. */
export const style = {
  info: (s: string): string => style.style(chalk.blue, s),
  success: (s: string): string => style.style(chalk.green, s),
  warn: (s: string): string => style.style(chalk.yellow, s),
  error: (s: string): string => style.style(chalk.red, s),
  dim: (s: string): string => style.style(chalk.gray, s),
  bold: (s: string): string => style.style(chalk.bold, s),
  cyan: (s: string): string => style.style(chalk.cyan, s),
  magenta: (s: string): string => style.style(chalk.magenta, s),
  style: (fn: ChalkInstance, s: string): string => (noColor ? s : fn(s)),
};

/** Generic writers — go to stderr for human noise, stdout for data. */
export const log = {
  info: (msg: string): void => {
    if (!quiet) process.stderr.write(`${style.info('ℹ')} ${msg}\n`);
  },
  success: (msg: string): void => {
    if (!quiet) process.stderr.write(`${style.success('✓')} ${msg}\n`);
  },
  warn: (msg: string): void => {
    if (!quiet) process.stderr.write(`${style.warn('⚠')} ${msg}\n`);
  },
  error: (msg: string): void => {
    // Errors are never silenced — even in --quiet mode the user needs
    // to know things failed.
    process.stderr.write(`${style.error('✗')} ${msg}\n`);
  },
  detail: (label: string, value: string): void => {
    if (!quiet) process.stderr.write(`  ${style.dim(label)}: ${value}\n`);
  },
};

/** Print a chunk of human output to stdout (a table, a header, etc.). */
export function print(line: string): void {
  if (!quiet) process.stdout.write(`${line}\n`);
}

/**
 * Print a JSON payload to stdout. Always runs, regardless of quiet
 * mode — `--json --quiet` is the recommended AI-agent shape and
 * silently dropping the data would be the worst possible failure.
 *
 * Output mode:
 *   - `--json` alone: pretty-printed with 2-space indent (humans
 *     piping through `less` or eyeballing the response benefit).
 *   - `--json --quiet`: single-line compact JSON. Cheaper to stream
 *     through `xargs`/`jq -c` and matches the NDJSON shape consumers
 *     are already wired up for.
 *
 * BigInts are coerced to strings (the SDK never returns BigInts at
 * the time of writing, but the helper is defensive). Non-finite
 * numbers (`NaN`, `Infinity`, `-Infinity`) are coerced to `null` —
 * `JSON.stringify` would silently emit `null` for them anyway, but
 * the explicit branch documents the choice + makes the contract
 * stable across Node versions.
 */
export function printJson(value: unknown): void {
  const indent = quiet ? undefined : 2;
  // Order matters: filter narrows the entries first, then fields
  // projects the surviving ones. The reverse would project fields
  // OFF the records the filter then can't see — confusing for users
  // (`--filter status==ACTIVE --fields id` should still filter on
  // status, even though the projected output drops it).
  const filtered = filter === undefined ? value : applyFilter(value, filter);
  const projected = fields === undefined ? filtered : projectFields(filtered, fields);
  process.stdout.write(`${JSON.stringify(projected, jsonReplacer, indent)}\n`);
}

/**
 * Single source of truth for the JSON replacer. Handles:
 *
 *   - `bigint` → decimal string (lossless representation; JSON has
 *     no native bigint type).
 *   - `NaN` / `Infinity` / `-Infinity` → `null` (explicit; matches
 *     JSON.stringify's silent default but is documented here).
 *
 * **Date handling.** `Date` instances reach the replacer *after*
 * `JSON.stringify` has already invoked their `toJSON()` method
 * (returning the ISO-8601 string). The replacer receives a string,
 * not a `Date`, so dates are emitted as ISO-8601 — the same shape
 * the API returns for `created_at` / `resolved_at` style fields.
 * Callers that need a different format must transform the value
 * before reaching `printJson`.
 *
 * Returns the original value otherwise. Stable contract — agents
 * pinning to the JSON shape can rely on these substitutions.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function isQuiet(): boolean {
  return quiet;
}

/**
 * Emit a single record as one line of newline-delimited JSON
 * (NDJSON). Used by `--ndjson` paginated commands so an AI agent can
 * stream-process arbitrarily large result sets without buffering the
 * full array.
 *
 * BigInts are coerced to strings — same defensive policy as
 * {@link printJson}.
 */
export function writeNdjson(value: unknown): void {
  // NDJSON emits one record at a time. Filter on a single-record
  // value returns `null` when the predicate fails; we skip those
  // entirely (don't emit a `null` line — that would corrupt the
  // stream for consumers expecting one record per line).
  const filtered = filter === undefined ? value : applyFilter(value, filter);
  if (filtered === null && filter !== undefined) return;
  const projected = fields === undefined ? filtered : projectFields(filtered, fields);
  process.stdout.write(`${JSON.stringify(projected, jsonReplacer)}\n`);
}
