/**
 * `kash config profiles` — list every profile in the config file.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { listProfiles } from '../../utils/config-store.js';
import { createTable } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

export const profilesCommand = new Command('profiles')
  .description('List configured profiles in the config file.')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config profiles
  $ kash config profiles --json --quiet | jq -r '.profiles[]'
`
  )
  .action(async (_opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    let result;
    try {
      result = await listProfiles({
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(result);
      return;
    }

    if (result.profiles.length === 0) {
      log.info('No profiles configured.');
      log.detail('Hint', "Run 'kash auth set-key <key>' to create the default profile.");
      return;
    }

    const table = createTable(['Active', 'Profile']);
    for (const name of result.profiles) {
      table.push([name === result.current ? style.success('•') : ' ', name]);
    }
    print(table.toString());
  });
