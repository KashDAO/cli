/**
 * `kash auth logout` — remove the stored API key.
 *
 * Only clears the `apiKey` field; the rest of the config (baseUrl,
 * chain id) survives so logging back in doesn't lose unrelated
 * preferences. If `KASH_API_KEY` is set in the environment, we warn
 * the user that env vars take precedence so the "logout" is partial.
 */

import { Command } from 'commander';

import { clearConfigField, readConfig } from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, printJson } from '../../utils/output.js';

export const logoutCommand = new Command('logout')
  .description('Remove the stored API key from ~/.kash/config.json.')
  .addHelpText(
    'after',
    `
Examples:
  $ kash auth logout
  $ kash auth logout --profile staging
`
  )
  .action(async (_opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const scope = {
      ...(globals.profile === undefined ? {} : { profile: globals.profile }),
      ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
    };
    const before = await readConfig(scope);
    await clearConfigField('apiKey', scope);

    const envWillOverride = Boolean(process.env['KASH_API_KEY']);

    if (globals.json) {
      printJson({
        ok: true,
        profile: before.profile,
        cleared: Boolean(before.apiKey && before.sources.apiKey === 'file'),
        envOverride: envWillOverride,
      });
      return;
    }

    if (before.apiKey === undefined) {
      log.info(`No API key was stored for profile "${before.profile}".`);
    } else {
      log.success(`API key cleared from profile "${before.profile}".`);
    }
    if (envWillOverride) {
      log.warn('KASH_API_KEY is still set in your environment. Unset it to fully log out.');
    }
  });
