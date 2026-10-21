/**
 * `kash config show` — print the resolved configuration.
 *
 * Sources are surfaced (env vs file vs default) so users can debug
 * "why is my key not picking up?" without reading the source.
 */

import { Command } from 'commander';

import { readConfig } from '../../utils/config-store.js';
import { redact } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';

export const showConfigCommand = new Command('show')
  .description('Print the resolved CLI configuration.')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config show
  $ kash config show --profile staging
  $ kash config show --json --quiet | jq -r '.baseUrl'
`
  )
  .action(async (_opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const config = await readConfig({
      ...(globals.profile === undefined ? {} : { profile: globals.profile }),
      ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
    });

    if (globals.json) {
      // Shape pinned by `CliConfigEnvelopeSchema` in `cli-schemas.ts`.
      // Includes `authenticated` so it agrees with `auth status` —
      // agents that bind one shape can consume the other.
      printJson({
        profile: config.profile,
        authenticated: Boolean(config.apiKey),
        apiKey: config.apiKey ? redact(config.apiKey) : null,
        baseUrl: config.baseUrl,
        apiVersion: config.apiVersion,
        sources: config.sources,
      });
      return;
    }

    print('');
    print(`  ${style.dim('Profile        ')} ${config.profile} (${config.sources.profile})`);
    print(
      `  ${style.dim('API key        ')} ${config.apiKey ? redact(config.apiKey) : '(unset)'} (${config.sources.apiKey})`
    );
    print(`  ${style.dim('Base URL       ')} ${config.baseUrl} (${config.sources.baseUrl})`);
    print(`  ${style.dim('API version    ')} ${config.apiVersion} (${config.sources.apiVersion})`);
  });
