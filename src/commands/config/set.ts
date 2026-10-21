/**
 * `kash config set <key> <value>` — write a single config field.
 *
 * The value is parsed and validated by the same Zod schema used to
 * read the file, so corruption is impossible without bypassing the
 * CLI. Keys: `apiKey`, `baseUrl`, `apiVersion`.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import {
  cliConfigSchema,
  updateConfig,
  type CliConfig,
  type UpdateConfigResult,
} from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, printJson } from '../../utils/output.js';

const TOP_LEVEL_KEYS = ['apiKey', 'baseUrl', 'apiVersion'] as const;
type TopLevelKey = (typeof TOP_LEVEL_KEYS)[number];

export const setConfigCommand = new Command('set')
  .description('Set a single config field.')
  .argument('<key>', `config key: ${TOP_LEVEL_KEYS.join(', ')}`)
  .argument('<value>', 'value to set')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config set baseUrl https://api-staging.kash.bot/v1 --profile staging
  $ kash config set apiVersion 2026-08-19
`
  )
  .action(async (key: string, value: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    let patch: Partial<CliConfig>;
    try {
      patch = buildPatchForKey(key, value);
    } catch (cause) {
      throw toCliError(cause);
    }

    let result: UpdateConfigResult;
    try {
      result = await updateConfig(patch, {
        ...(globals.profile === undefined ? {} : { profile: globals.profile }),
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      // The resolved profile (from updateConfig) is the truth — when
      // the user runs `kash config set foo bar` with no flag, the
      // value lands in whatever profile the file's `currentProfile`
      // points at, NOT in the unconditional 'default'.
      printJson({
        ok: true,
        key,
        value: result.stored[key as TopLevelKey] ?? null,
        profile: result.profile,
      });
      return;
    }
    log.success(`Set ${key} on profile "${result.profile}".`);
  });

function isTopLevelKey(value: string): value is TopLevelKey {
  return (TOP_LEVEL_KEYS as readonly string[]).includes(value);
}

/** Resolve a key to a partial-config patch, validated against the schema. */
function buildPatchForKey(key: string, value: string): Partial<CliConfig> {
  if (!isTopLevelKey(key)) {
    throw new CliValidationError(
      `Unknown config key "${key}".`,
      `Allowed keys: ${TOP_LEVEL_KEYS.join(', ')}.`
    );
  }
  const candidate: Partial<CliConfig> = { [key]: value };
  cliConfigSchema.parse(candidate);
  return candidate;
}
