/**
 * `kash config set <key> <value>` — write a single config field.
 *
 * The value is parsed and validated by the same Zod schema used to
 * read the file, so corruption is impossible without bypassing the
 * CLI.
 *
 * Two field families:
 *
 *   - **Custodial** (API-backed): `apiKey`, `baseUrl`, `defaultChainId`.
 *   - **Direct mode** (`kash protocol …`): `rpcUrl`, `smartAccount`,
 *     `bundlerUrl`, `bundlerProvider`, `signerKeyRef`.
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

const ALLOWED_KEYS = [
  // Custodial
  'apiKey',
  'baseUrl',
  'defaultChainId',
  // Direct mode
  'rpcUrl',
  'smartAccount',
  'bundlerUrl',
  'bundlerProvider',
  'signerKeyRef',
] as const;
type AllowedKey = (typeof ALLOWED_KEYS)[number];

export const setConfigCommand = new Command('set')
  .description('Set a single config field.')
  .argument('<key>', `one of: ${ALLOWED_KEYS.join(', ')}`)
  .argument('<value>', 'value to set')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config set baseUrl https://api-staging.kash.bot/v1 --profile staging
  $ kash config set defaultChainId 84532 --profile staging

Direct-mode (kash protocol …):
  $ kash config set rpcUrl https://base-mainnet.g.alchemy.com/v2/... --profile mm
  $ kash config set smartAccount 0xabc... --profile mm
  $ kash config set signerKeyRef file:~/.kash/keys/mm-owner.key --profile mm
  $ kash config set bundlerProvider flashbots --profile mm
`
  )
  .action(async (key: string, value: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    if (!isAllowedKey(key)) {
      throw new CliValidationError(
        `Unknown config key "${key}".`,
        `Allowed keys: ${ALLOWED_KEYS.join(', ')}.`
      );
    }
    const patch = buildPatch(key, value);
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
        value: result.stored[key] ?? null,
        profile: result.profile,
      });
      return;
    }
    log.success(`Set ${key} on profile "${result.profile}".`);
  });

function isAllowedKey(value: string): value is AllowedKey {
  return (ALLOWED_KEYS as readonly string[]).includes(value);
}

function buildPatch(key: AllowedKey, value: string): Partial<CliConfig> {
  switch (key) {
    // String fields validated by the schema directly.
    case 'apiKey':
    case 'baseUrl':
    case 'rpcUrl':
    case 'smartAccount':
    case 'bundlerUrl':
    case 'bundlerProvider':
    case 'signerKeyRef': {
      const candidate: Partial<CliConfig> = { [key]: value };
      cliConfigSchema.parse(candidate);
      return candidate;
    }
    case 'defaultChainId': {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new CliValidationError(
          'defaultChainId must be a positive integer.',
          undefined,
          'defaultChainId'
        );
      }
      const candidate: Partial<CliConfig> = { defaultChainId: n };
      cliConfigSchema.parse(candidate);
      return candidate;
    }
  }
}
