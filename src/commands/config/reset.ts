/**
 * `kash config reset` — delete the on-disk config file.
 *
 * Asks for confirmation when stdin is a TTY (the common interactive
 * case). In `--json` or `--quiet` mode, runs unconditionally so
 * scripts don't hang waiting for input.
 */

import readline from 'node:readline/promises';

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { deleteConfig, resolveConfigPathsForOverride } from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, printJson } from '../../utils/output.js';

type ResetOptions = {
  yes?: boolean;
};

export const resetConfigCommand = new Command('reset')
  .description('Delete ~/.kash/config.json.')
  .option('-y, --yes', 'skip the interactive confirmation')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config reset
  $ kash config reset --yes --json --quiet
`
  )
  .action(async (options: ResetOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const paths = resolveConfigPathsForOverride(globals.configPath);

    const interactive = process.stdin.isTTY && !globals.quiet && !globals.json;
    const confirmed = options.yes || !interactive ? true : await confirm(paths.file);
    if (!confirmed) {
      log.info('Aborted.');
      return;
    }

    try {
      await deleteConfig({
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson({ ok: true, deleted: paths.file });
      return;
    }
    log.success(`Deleted ${paths.file}.`);
  });

async function confirm(path: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Delete ${path}? [y/N] `);
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}
