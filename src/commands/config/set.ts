/**
 * `kash config set <key> <value>` — write a single config field.
 *
 * The value is parsed and validated by the same Zod schema used to
 * read the file, so corruption is impossible without bypassing the
 * CLI.
 *
 * Three field families:
 *
 *   - **Kash-orchestrated** (API-backed): `apiKey`, `baseUrl`, `defaultChainId`.
 *   - **Direct mode** (`kash protocol …`): `rpcUrl`, `smartAccount`,
 *     `bundlerUrl`, `bundlerProvider`, `signerKeyRef`.
 *   - **Custom chain** (Anvil / forks / sidechains, dot-path syntax):
 *     `customChain.name`, `customChain.factoryAddress`, etc. Including
 *     `customChain.smartAccount.factoryAddress`/`implementationAddress`/
 *     `entryPointAddress` for SA mode on chains the protocol-sdk
 *     registry doesn't cover.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import {
  cliConfigSchema,
  readConfig,
  updateConfig,
  type CliConfig,
  type UpdateConfigResult,
} from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, printJson } from '../../utils/output.js';

const TOP_LEVEL_KEYS = [
  // Kash-orchestrated
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
type TopLevelKey = (typeof TOP_LEVEL_KEYS)[number];

const CUSTOM_CHAIN_LEAVES = [
  'name',
  'factoryAddress',
  'usdcAddress',
  'oracleAddress',
  'vaultAddress',
  'tokens1155Address',
  'paramRegistryAddress',
] as const;
type CustomChainLeaf = (typeof CUSTOM_CHAIN_LEAVES)[number];

const CUSTOM_CHAIN_SA_LEAVES = [
  'factoryAddress',
  'implementationAddress',
  'entryPointAddress',
] as const;
type CustomChainSaLeaf = (typeof CUSTOM_CHAIN_SA_LEAVES)[number];

const ALL_KEYS_FOR_HELP = [
  ...TOP_LEVEL_KEYS,
  ...CUSTOM_CHAIN_LEAVES.map((l) => `customChain.${l}`),
  ...CUSTOM_CHAIN_SA_LEAVES.map((l) => `customChain.smartAccount.${l}`),
];

export const setConfigCommand = new Command('set')
  .description('Set a single config field.')
  .argument(
    '<key>',
    'top-level key OR `customChain.<leaf>` / `customChain.smartAccount.<leaf>` dot-path'
  )
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

Custom chain (local Anvil / forks / sidechains, bypasses static registry):
  $ kash config set defaultChainId 31337 --profile anvil
  $ kash config set rpcUrl http://localhost:8545 --profile anvil
  $ kash config set customChain.name "Anvil local" --profile anvil
  $ kash config set customChain.factoryAddress 0xCf7Ed... --profile anvil
  $ kash config set customChain.usdcAddress 0x5FbDB... --profile anvil
  $ kash config set customChain.smartAccount.factoryAddress 0x3Aa5e... --profile anvil
`
  )
  .action(async (key: string, value: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    let patch: Partial<CliConfig>;
    try {
      patch = await buildPatchForKey(key, value, {
        ...(globals.profile === undefined ? {} : { profile: globals.profile }),
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });
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
      const top = key.split('.', 1)[0] as keyof CliConfig;
      printJson({
        ok: true,
        key,
        value: result.stored[top] ?? null,
        profile: result.profile,
      });
      return;
    }
    log.success(`Set ${key} on profile "${result.profile}".`);
  });

function isTopLevelKey(value: string): value is TopLevelKey {
  return (TOP_LEVEL_KEYS as readonly string[]).includes(value);
}

function isCustomChainLeaf(value: string): value is CustomChainLeaf {
  return (CUSTOM_CHAIN_LEAVES as readonly string[]).includes(value);
}

function isCustomChainSaLeaf(value: string): value is CustomChainSaLeaf {
  return (CUSTOM_CHAIN_SA_LEAVES as readonly string[]).includes(value);
}

/**
 * Resolve a (possibly dot-pathed) key to a partial-config patch. For
 * `customChain.*` paths we read-modify-write the existing object so
 * the user can set leaves one at a time without losing prior fields.
 */
async function buildPatchForKey(
  key: string,
  value: string,
  readOpts: { readonly profile?: string; readonly configPath?: string }
): Promise<Partial<CliConfig>> {
  if (isTopLevelKey(key)) {
    return buildTopLevelPatch(key, value);
  }

  // customChain.<leaf> or customChain.smartAccount.<leaf> — read the
  // existing customChain object so partial sets compose, then validate
  // the merged shape against the full schema.
  if (key.startsWith('customChain.')) {
    const existing = await readConfig(readOpts);
    const existingChain = existing.customChain ?? {};
    const merged = mergeCustomChainLeaf(existingChain, key, value);
    const candidate: Partial<CliConfig> = { customChain: merged };
    // Validate the merged customChain against the schema. If the
    // user has only set a name + factoryAddress so far this will
    // fail the required usdcAddress check — that's the correct
    // behaviour: customChain on disk is always a complete object.
    cliConfigSchema.parse(candidate);
    return candidate;
  }

  throw new CliValidationError(
    `Unknown config key "${key}".`,
    `Allowed keys: ${ALL_KEYS_FOR_HELP.join(', ')}.`
  );
}

function buildTopLevelPatch(key: TopLevelKey, value: string): Partial<CliConfig> {
  switch (key) {
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

/**
 * Merge a single dot-pathed leaf into the existing `customChain`
 * object. Handles both flat leaves (`customChain.factoryAddress`) and
 * the one nested level (`customChain.smartAccount.factoryAddress`).
 *
 * The returned object is then re-validated against the full
 * `customChainSchema` by the caller — leaves that violate the leaf
 * regex (e.g. malformed hex) surface their schema error there, and
 * the required-field check (factoryAddress + usdcAddress) ensures we
 * never persist a half-built customChain.
 */
function mergeCustomChainLeaf(
  existing: NonNullable<CliConfig['customChain']> | Record<string, unknown>,
  key: string,
  value: string
): NonNullable<CliConfig['customChain']> {
  const path = key.slice('customChain.'.length);

  if (path.startsWith('smartAccount.')) {
    const leaf = path.slice('smartAccount.'.length);
    if (!isCustomChainSaLeaf(leaf)) {
      throw new CliValidationError(
        `Unknown customChain.smartAccount leaf "${leaf}".`,
        `Allowed: ${CUSTOM_CHAIN_SA_LEAVES.map((l) => `customChain.smartAccount.${l}`).join(', ')}.`
      );
    }
    const sa = (existing as { smartAccount?: Record<string, unknown> }).smartAccount ?? {};
    return {
      ...(existing as NonNullable<CliConfig['customChain']>),
      smartAccount: { ...sa, [leaf]: value } as NonNullable<
        NonNullable<CliConfig['customChain']>['smartAccount']
      >,
    };
  }

  if (!isCustomChainLeaf(path)) {
    throw new CliValidationError(
      `Unknown customChain leaf "${path}".`,
      `Allowed: ${CUSTOM_CHAIN_LEAVES.map((l) => `customChain.${l}`).join(', ')}, customChain.smartAccount.<leaf>.`
    );
  }
  return {
    ...(existing as NonNullable<CliConfig['customChain']>),
    [path]: value,
  };
}
