/**
 * `kash config remove <profile>` — delete a named profile from the
 * config file. Refuses to delete the active profile (consistent with
 * `kash auth logout` which only clears the apiKey).
 *
 * Symmetric with `kash config use` and `kash config profiles`: every
 * write surface a multi-profile setup needs is now a first-class
 * command.
 */

import { Command } from 'commander';

import { toCliError } from '../../errors.js';
import { deleteProfile } from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, printJson } from '../../utils/output.js';

export const removeProfileCommand = new Command('remove')
  .description('Delete a named profile from the config file.')
  .argument('<profile>', 'profile name to remove')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config remove staging
  $ kash config remove old-profile --json --quiet
`
  )
  .action(async (profile: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    let updated;
    try {
      updated = await deleteProfile(profile, {
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson({
        ok: true,
        removed: profile,
        profiles: Object.keys(updated.profiles).sort(),
      });
      return;
    }
    log.success(`Profile "${profile}" removed.`);
  });
