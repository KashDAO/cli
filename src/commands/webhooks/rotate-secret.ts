/**
 * `kash webhooks rotate-secret` — rotate the signing secret for the
 * authenticating API key. The plaintext secret is returned ONCE.
 *
 * This is a destructive operation: the current secret is invalidated
 * immediately on success. Interactive callers (TTY, not --json, not
 * --quiet) get a confirmation prompt to prevent one-keystroke prod
 * webhook breakage. CI / scripted callers can bypass with `--yes`,
 * which is also what `--json --quiet` implies (no TTY for prompting,
 * caller knows what it's doing).
 */

import readline from 'node:readline/promises';

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { formatDate } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

type RotateOptions = {
  yes?: boolean;
};

export const rotateSecretCommand = new Command('rotate-secret')
  .description('Rotate the webhook signing secret for the current API key.')
  .option('-y, --yes', 'skip the interactive confirmation (required for --json --quiet)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash webhooks rotate-secret                        # interactive confirm
  $ kash webhooks rotate-secret --yes                  # skip confirm
  $ kash webhooks rotate-secret --yes --json --quiet | jq -r '.secret' > new-secret.txt

Notes:
  This invalidates your current webhook secret immediately. Receivers
  that haven't been updated will start failing signature verification
  on the next event. Have your secret-store update plan ready before
  confirming.
`
  )
  .action(async (options: RotateOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    const interactive = process.stdin.isTTY && !globals.quiet && !globals.json;
    const confirmed = options.yes === true || !interactive ? true : await confirm();
    if (!confirmed) {
      log.info('Aborted.');
      return;
    }

    let secret;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      secret = await client.webhooks.rotateSecret();
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(secret);
      return;
    }

    log.warn('Webhook secret rotated. The new secret is shown ONCE.');
    print('');
    print(`  ${style.bold('Secret')}: ${secret.secret}`);
    print(`  ${style.dim('Rotated at        ')}: ${formatDate(secret.rotatedAt)}`);
    print(`  ${style.dim('Previous valid until')}: ${formatDate(secret.previousRetainedUntil)}`);
    print('');
    log.info('Store this secret in your webhook receiver immediately.');
  });

async function confirm(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      'This will invalidate your current webhook secret. Continue? [y/N] '
    );
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}
