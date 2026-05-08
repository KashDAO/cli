/**
 * `kash explain <code>` — translate an error `code` into a structured
 * description, recovery steps, and a docs URL.
 *
 * Designed to be called by AI agents that hit an error with
 * `--json --quiet`, parse the `code` from the envelope, and want
 * deterministic, machine-readable next steps. The same data feeds
 * the human-mode error suggestion.
 *
 * `kash explain` (no argument) lists every code the CLI emits — useful
 * for agents at startup that want to learn the catalog up front.
 */

import { Command } from 'commander';

import { API_ERROR_DOCS } from '../api-error-bundle.generated.js';
import { ERROR_CATALOG, lookupErrorCode } from '../error-catalog.js';
import { CliError, type CliErrorAction } from '../errors.js';
import { createTable, truncate } from '../utils/formatting.js';
import { readGlobals } from '../utils/global-options.js';
import { print, printJson, style } from '../utils/output.js';

const API_DOCS_URL_BASE = 'https://docs.kash.bot/developer-docs/api-errors';

/**
 * Fallback for API server-side codes that aren't in the hand-curated
 * CLI ERROR_CATALOG. Returns the markdown body bundled at build time
 * from `docs/api-errors/<CODE>.md` so `kash explain MARKET_NOT_TRADEABLE`
 * works the same as `kash explain RATE_LIMITED` even though the latter
 * has rich CliError metadata and the former is server-only.
 */
function lookupApiErrorBody(code: string): string | undefined {
  return API_ERROR_DOCS[code];
}

export const explainCommand = new Command('explain')
  .description('Look up one or more error codes and their recommended recovery steps.')
  .argument('[codes...]', 'error codes to explain (omit to list every known code)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash explain                                # list every known error code
  $ kash explain RATE_LIMITED
  $ kash explain RATE_LIMITED NOT_FOUND --json  # bulk lookup for AI agents
`
  )
  .action((codes: readonly string[], _opts, cmd: Command) => {
    const globals = readGlobals(cmd);

    if (codes.length === 0) {
      if (globals.json) {
        printJson({ codes: ERROR_CATALOG });
        return;
      }
      const table = createTable(['Code', 'Summary', 'Recoverable']);
      for (const entry of ERROR_CATALOG) {
        table.push([
          entry.code,
          truncate(entry.summary, 60),
          entry.recoverable ? style.success('yes') : style.dim('no'),
        ]);
      }
      print(table.toString());
      return;
    }

    // Resolve every code first so we fail before printing anything if
    // any are unknown — agents iterating a list shouldn't get a
    // half-finished response.
    type Resolved =
      | { readonly source: 'cli'; readonly entry: ReturnType<typeof lookupErrorCode> & object }
      | { readonly source: 'api'; readonly code: string; readonly body: string };
    const entries: Resolved[] = codes.map((code) => {
      const entry = lookupErrorCode(code);
      if (entry) return { source: 'cli', entry };
      // Fall back to the bundled docs/api-errors/<CODE>.md content so
      // server-side API codes (MARKET_NOT_TRADEABLE, INSUFFICIENT_BALANCE,
      // CONFIRMATION_TOKEN_USED, …) work even though they don't have
      // hand-curated CLI metadata. Agents calling `--json` get a
      // distinct `source: 'api'` envelope so they can differentiate.
      const body = lookupApiErrorBody(code);
      if (body) return { source: 'api', code, body };
      throw new CliError(`Unknown error code: ${code}`, {
        code: 'INVALID_INPUT',
        recoverable: true,
        suggestion: 'Run `kash explain` (no argument) to list every known code.',
      });
    });

    if (globals.json) {
      // Single code: emit the entry directly (back-compat with the
      // historical single-arg shape).
      // Multiple codes: emit a `codes` array so consumers can branch.
      const payload = entries.map((r) =>
        r.source === 'cli'
          ? r.entry
          : {
              code: r.code,
              source: 'api' as const,
              docsUrl: `${API_DOCS_URL_BASE}/${r.code}`,
              body: r.body,
            }
      );
      printJson(payload.length === 1 ? payload[0] : { codes: payload });
      return;
    }

    for (const [i, resolved] of entries.entries()) {
      if (i > 0) print('');
      print('');
      if (resolved.source === 'api') {
        // Render the bundled markdown verbatim — it's already formatted
        // for human reading (per-code page template).
        print(resolved.body);
        print(style.dim(`Docs: ${API_DOCS_URL_BASE}/${resolved.code}`));
        continue;
      }
      const { entry } = resolved;
      print(`${style.bold(entry.code)}`);
      print(`  ${style.dim('Summary    ')} ${entry.summary}`);
      print(
        `  ${style.dim('Recoverable')} ${entry.recoverable ? style.success('yes') : style.dim('no')}`
      );
      if (entry.docsUrl) {
        print(`  ${style.dim('Docs       ')} ${entry.docsUrl}`);
      }
      print('');
      print(entry.description);
      if (entry.actions.length > 0) {
        print('');
        print(style.bold('Recovery actions:'));
        for (const action of entry.actions) {
          print(`  - ${formatAction(action)}`);
        }
      }
    }
  });

function formatAction(action: CliErrorAction): string {
  switch (action.type) {
    case 'run_command':
      return `${style.cyan(action.command)} — ${action.description}`;
    case 'set_env':
      return `${style.cyan(action.variable)} (env var) — ${action.description}`;
    case 'wait_and_retry':
      return `${style.cyan(`wait ${String(Math.round(action.delayMs / 1000))}s`)} — ${action.description}`;
    case 'open_url':
      return `${style.cyan(action.url)} — ${action.description}`;
    case 'check_input':
      return `${style.cyan(action.field)} (input field) — ${action.description}`;
  }
}
