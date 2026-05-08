/**
 * Inline docs footers for `--help` output.
 *
 * Every top-level command registered with the CLI gets a footer line
 * pointing at the matching docs page. Keeps the help output skimmable
 * while still giving users (and AI agents reading `kash docs --json`)
 * a deep-link to the prose explanation.
 *
 * Footer text is appended via Commander's `addHelpText('after', ...)`,
 * which appears after `Examples:` (when present) but before Commander's
 * own boilerplate. Commands that already have an `addHelpText` block
 * stack with this one — order is registration order.
 */

import type { Command } from 'commander';

const DOCS_BASE_URL = 'https://kash.bot/docs/cli';

/**
 * Append a one-line "More: <url>" footer to the command's `--help`
 * output. The URL is composed from `DOCS_BASE_URL` + the supplied
 * slug. Pass slug `''` to point at the CLI index page.
 *
 * Typical usage at the registration site:
 *
 * ```ts
 * import { withDocsFooter } from '../utils/help-footer.js';
 *
 * const marketsCommand = withDocsFooter(
 *   new Command('markets').description('…'),
 *   'markets'
 * );
 * ```
 *
 * The helper returns the same command instance so it can be chained
 * inline with the rest of the builder.
 */
export function withDocsFooter(cmd: Command, slug: string): Command {
  const url = slug ? `${DOCS_BASE_URL}/${slug}` : DOCS_BASE_URL;
  cmd.addHelpText('after', `\nMore: ${url}\n`);
  return cmd;
}

/**
 * Apply a docs-footer line to every top-level command registered on
 * the root program. Maps known command names to their docs slug; any
 * command whose name isn't in the map gets the CLI-index footer.
 *
 * Call this AFTER all `program.addCommand(...)` calls so we walk the
 * fully-populated tree.
 */
export function attachDocsFooters(program: Command): void {
  const slugByName: Record<string, string> = {
    account: 'account',
    auth: 'authentication',
    markets: 'markets',
    quote: 'quotes',
    trade: 'trades',
    portfolio: 'portfolio',
    protocol: 'direct-mode',
    eoa: 'eoa-mode',
    webhooks: 'webhooks',
    config: 'configuration',
    health: 'health',
    version: 'version',
    explain: 'errors',
    schema: 'schemas',
    setup: 'setup',
    trace: 'trace',
    'with-retry': 'with-retry',
    docs: 'introspection',
    completion: 'completion',
  };

  for (const cmd of program.commands) {
    const slug = slugByName[cmd.name()] ?? '';
    withDocsFooter(cmd, slug);
  }
}
