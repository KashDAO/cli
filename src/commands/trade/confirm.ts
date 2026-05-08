/**
 * `kash trade confirm <id> [token]` — confirm a high-value trade.
 *
 * High-value trades come back from `POST /v1/trades` with HTTP 202 and
 * a one-time confirmation token. This command POSTs that token to
 * `/v1/trades/{id}/confirm` to release the trade for execution.
 *
 * Token input is sensitive (a captured token plus the trade id is
 * sufficient to release real money), so we support three input
 * paths that don't taint shell history:
 *
 *   1. Positional `<token>` — convenient, but lands in `~/.bash_history`.
 *      Kept for backward compat.
 *   2. `--token-stdin` — pipe a token (the natural shape after
 *      capturing the 202 envelope into a file or secret store).
 *   3. Interactive prompt — TTY only, prompt goes to stderr so the
 *      stdout pipe stays clean.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { colorStatus, formatUsdcDecimal } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

type ConfirmOptions = {
  tokenStdin?: boolean;
};

export const confirmCommand = new Command('confirm')
  .description('Confirm a high-value trade using its one-time token.')
  .argument('<id>', 'trade UUID')
  .argument('[token]', 'confirmation token (omit to read from stdin or prompt)')
  .option('--token-stdin', 'read the confirmation token from stdin')
  .addHelpText(
    'after',
    `
Examples:
  # Interactive prompt (no shell history footprint).
  $ kash trade confirm 9f0b...

  # Pipe from a captured token.
  $ cat token.txt | kash trade confirm 9f0b... --token-stdin

  # Positional (convenient but shows up in ~/.bash_history).
  $ kash trade confirm 9f0b... eyJ...
  $ kash trade confirm 9f0b... eyJ... --json --quiet
`
  )
  .action(
    async (id: string, positional: string | undefined, options: ConfirmOptions, cmd: Command) => {
      const globals = readGlobals(cmd);
      const token = await resolveToken(positional, options);

      let trade;
      try {
        const { client } = await buildClient({ requireAuth: true, globals });
        trade = await client.trades.confirm(id, { token });
      } catch (cause) {
        throw toCliError(cause);
      }

      if (globals.json) {
        printJson(trade);
        return;
      }

      log.success(`Trade ${trade.id} confirmed.`);
      print(`  ${style.dim('Status     ')} ${colorStatus(trade.status)}`);
      print(`  ${style.dim('Amount     ')} ${formatUsdcDecimal(trade.amount)}`);
      log.info("Run 'kash trade status <id> --poll' to follow it to completion.");
    }
  );

async function resolveToken(
  positional: string | undefined,
  options: ConfirmOptions
): Promise<string> {
  // Mutual-exclusion guard: `kash trade confirm <id> <token> --token-stdin`
  // would silently take the positional and drop the piped value.
  // That's a real footgun on a real-money path — refuse to guess.
  if (positional !== undefined && positional !== '' && options.tokenStdin === true) {
    throw new CliValidationError(
      'Pass either the positional [token] OR --token-stdin, not both.',
      'The positional token would silently win and the piped value would be dropped.',
      'token'
    );
  }
  if (positional !== undefined && positional !== '') {
    return positional;
  }
  if (options.tokenStdin === true) {
    // BOM-aware read — see `utils/stdin.ts` for rationale.
    const { readStdinTrimmed } = await import('../../utils/stdin.js');
    return readStdinTrimmed();
  }
  if (process.stdin.isTTY) {
    // Use the masked-input prompt — confirmation tokens are sensitive
    // (a captured token + the trade id is enough to release real
    // money) and `readline.question` would echo every keystroke.
    const { password } = await import('@inquirer/prompts');
    const answer = await password({
      message: 'Paste the confirmation token:',
      mask: '*',
    });
    return answer.trim();
  }
  throw new CliValidationError(
    'No confirmation token provided.',
    'Pass the token positionally, use --token-stdin to read it from a pipe, or run interactively for a prompt.',
    'token'
  );
}
