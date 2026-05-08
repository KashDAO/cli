/**
 * `kash config use <profile>` — switch the active profile by writing
 * the file's `currentProfile` field.
 *
 * **Existence check.** By default we refuse to switch to a profile
 * that doesn't already exist — `kash config use staing` (typo) used
 * to silently succeed and the next command would fail with a
 * confusing `AUTH_REQUIRED`. Now we surface the typo with a list of
 * known profile names. The "set up a fresh profile" flow opts in via
 * `--allow-new`: `kash config use newprofile --allow-new` followed by
 * `kash auth set-key --profile newprofile <key>`.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { readWholeFile, setCurrentProfile } from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, printJson } from '../../utils/output.js';

type UseProfileOptions = {
  allowNew?: boolean;
};

export const useProfileCommand = new Command('use')
  .description('Switch the active profile (writes currentProfile to the config file).')
  .argument('<profile>', 'profile name')
  .option(
    '--allow-new',
    'permit switching to a profile that does not yet exist (you must populate it via `kash auth set-key --profile <name>` afterwards)'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash config use staging
  $ kash config use prod --json --quiet
  $ kash config use newprofile --allow-new   # explicitly create a fresh profile

Notes:
  - By default \`kash config use\` refuses unknown profile names and
    lists the known ones — a typo of an existing profile name would
    otherwise surface later as a confusing AUTH_REQUIRED.
  - Use \`--allow-new\` for the bootstrapping flow when you genuinely
    want to switch to a not-yet-populated profile.
`
  )
  .action(async (profile: string, options: UseProfileOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const configPathOpt =
      globals.configPath === undefined ? {} : { configPath: globals.configPath };

    // Existence check: load the file once to see which profiles
    // exist, then either surface a structured "did you mean" error or
    // proceed with the write.
    let knownProfiles: readonly string[];
    try {
      const file = await readWholeFile(configPathOpt);
      knownProfiles = Object.keys(file.profiles).sort();
    } catch (cause) {
      throw toCliError(cause);
    }

    if (!knownProfiles.includes(profile) && options.allowNew !== true) {
      const known = knownProfiles.length === 0 ? '(none yet)' : knownProfiles.join(', ');
      throw new CliValidationError(
        `Profile "${profile}" does not exist.`,
        `Known profiles: ${known}. Pass --allow-new to create + switch to a fresh profile (you'll then need to populate it with \`kash auth set-key --profile ${profile}\`).`,
        'profile'
      );
    }

    let updated;
    try {
      updated = await setCurrentProfile(profile, configPathOpt);
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson({
        ok: true,
        currentProfile: updated.currentProfile,
        profiles: Object.keys(updated.profiles).sort(),
        // Surface whether this was a new-profile switch — agents can
        // pipe to `kash auth set-key --profile <p>` automatically when
        // `created` is true.
        created: !knownProfiles.includes(profile),
      });
      return;
    }
    log.success(`Active profile is now "${profile}".`);
    if (!knownProfiles.includes(profile)) {
      log.info(`Profile is empty. Populate it with: kash auth set-key --profile ${profile} <key>`);
    }
  });
