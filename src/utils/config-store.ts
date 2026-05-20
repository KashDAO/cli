/**
 * Persistent CLI configuration with multi-profile support.
 *
 * The on-disk shape (v1+):
 *
 *   {
 *     "version": 1,
 *     "currentProfile": "default",
 *     "profiles": {
 *       "default": { "apiKey": "kash_live_…", "baseUrl": "…", "defaultChainId": 8453 },
 *       "test":    { "apiKey": "kash_test_…" }
 *     }
 *   }
 *
 * Flat-shape configs from earlier CLI versions are migrated transparently
 * on first read into a `default` profile. The on-disk file is rewritten
 * in the new shape only on the next write — readers don't mutate state.
 *
 * The file is created and re-written at mode `0600` on POSIX. The
 * directory is created with `0700`. chmod is best-effort — Windows and
 * some network filesystems silently ignore it.
 *
 * Resolution order (highest precedence first):
 *
 *   1. Environment variables: `KASH_API_KEY`, `KASH_BASE_URL`,
 *      `KASH_CHAIN_ID`. Always win.
 *   2. The active profile's fields.
 *   3. Built-in defaults (api.kash.bot/v1, chain 8453).
 *
 * Active-profile resolution (highest precedence first):
 *
 *   1. Explicit `--profile <name>` flag (via `options.profile`).
 *   2. `KASH_PROFILE` env var.
 *   3. `currentProfile` field in the config file.
 *   4. `'default'`.
 *
 * Pinning env-var precedence makes CI runs predictable and lets a
 * human override a profile field without editing the file.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { CliConfigurationError } from '../errors.js';

import { HEX_ADDRESS_REGEX } from './trade-input.js';

/**
 * Return a shallow copy of `obj` without the named property. Cleaner
 * than the `const { [k]: _removed, ...rest } = obj` rest-spread idiom
 * because it avoids the unused-variable lint dance.
 */
function omitKey<T extends Record<string, unknown>, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (k !== key) result[k] = obj[k];
  }
  return result as Omit<T, K>;
}

/** Filesystem layout for the config — exposed for tests to override `home`. */
export type ConfigPaths = {
  readonly home: string;
  readonly dir: string;
  readonly file: string;
};

export function resolveConfigPaths(home: string = homedir()): ConfigPaths {
  const dir = join(home, '.kash');
  return { home, dir, file: join(dir, 'config.json') };
}

/**
 * Resolve config paths with an optional explicit override path
 * (typically from the `--config` flag or `KASH_CONFIG` env var). The
 * explicit override sets the file directly and derives `dir`/`home`
 * from it for chmod-on-write.
 */
export function resolveConfigPathsForOverride(
  override: string | undefined,
  envOverride: string | undefined = process.env['KASH_CONFIG']
): ConfigPaths {
  const explicit = override ?? envOverride;
  if (explicit) {
    const dir = dirname(explicit);
    return { home: dirname(dir), dir, file: explicit };
  }
  return resolveConfigPaths();
}

export const DEFAULT_PROFILE = 'default';

/**
 * Profile-name reserved words. Even though the regex below already
 * blocks the most-dangerous shapes (no `[`, no `<`, no whitespace),
 * the `__proto__` / `constructor` / `prototype` strings ARE allowed
 * by `[A-Za-z0-9_.-]+` — and using them as keys on a plain object
 * (`file.profiles`) walks the prototype chain on read. The denylist
 * makes the prototype-walk impossible at the schema layer.
 *
 * Defence-in-depth: the file format already uses `Object.create(null)`
 * boundaries downstream where possible, but pinning the validator
 * here makes the invariant grep-discoverable.
 */
const RESERVED_PROFILE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Profile name validator — keeps file structure deterministic. */
const profileNameSchema = z
  .string()
  .min(1, 'profile name cannot be empty')
  .max(64, 'profile name must be ≤ 64 characters')
  .regex(/^[A-Za-z0-9_.-]+$/, 'profile name allows letters, digits, underscore, dot, and dash only')
  .refine((name) => !RESERVED_PROFILE_NAMES.has(name), {
    message:
      'profile name uses a reserved word (__proto__, constructor, prototype) — would walk the object prototype chain',
  });

/**
 * Schema for a single profile. Every field is optional so the profile
 * can hold partial state — e.g. only override `baseUrl` while
 * inheriting the API key from env.
 */
/**
 * Reference to a private key the CLI will load when constructing the
 * direct-mode signer. We never persist the raw key — only a reference
 * to where to read it from at invocation time:
 *
 *   - `file:<path>`   — read the key from a file (mode 0600 enforced
 *                       at read time, not write).
 *   - `env:<name>`    — read the key from an environment variable.
 *
 * This keeps `~/.kash/config.json` free of secret material; the
 * config file itself is only `0600`-protected for the API key, not
 * for arbitrary private keys that could fund-drain a smart account.
 *
 * Future extensions: `keystore:<path>`, `aws-kms:<key-id>`,
 * `gcp-kms:<resource>`, `ledger:<derivation-path>`.
 */
const signerKeyRefSchema = z
  .string()
  .regex(/^(file:|env:)\S+$/, 'signerKeyRef must start with "file:<path>" or "env:<NAME>"');

/** Bundler provider preset. */
const bundlerProviderSchema = z.enum(['flashbots', 'pimlico', 'alchemy', 'generic']);

const hexAddressSchema = z
  .string()
  .regex(HEX_ADDRESS_REGEX, 'must be a 0x-prefixed 40-char hex address');

/**
 * Custom-chain config — bypasses the protocol-sdk's static chain
 * registry. Required for any chain Kash hasn't deployed canonical
 * contracts on (local Anvil, Hardhat, Tenderly forks, sidechains).
 *
 * The CLI derives the `viemChain` argument the SDK needs from the
 * profile's `defaultChainId` + `rpcUrl` + `customChain.name`; the
 * consumer never has to hand-construct a viem Chain. `addresses`
 * mirrors the SDK's `CustomChainAddresses`. `smartAccount` is required
 * only when the consumer is using SA mode (`kash protocol …`) on a
 * custom chain — EOA mode ignores it.
 */
/**
 * Custom-chain schema. Every field is optional at the persistence
 * layer because `kash config set customChain.<leaf>` writes one leaf
 * at a time — requiring the full shape at write time would force the
 * user into a single mega-set call. Completeness (name +
 * factoryAddress + usdcAddress required, smartAccount triple all-or-
 * nothing) is enforced at use time in `resolveCliCustomChain`,
 * where the missing field has actionable error context (the SDK call
 * that needs it).
 */
const customChainSchema = z
  .object({
    /** Human-readable label, surfaced on `client.addresses.name`. */
    name: z.string().min(1, 'customChain.name must not be empty').optional(),
    factoryAddress: hexAddressSchema.optional(),
    usdcAddress: hexAddressSchema.optional(),
    oracleAddress: hexAddressSchema.optional(),
    vaultAddress: hexAddressSchema.optional(),
    tokens1155Address: hexAddressSchema.optional(),
    paramRegistryAddress: hexAddressSchema.optional(),
    /** Smart-account factory + EntryPoint config (SA mode only). */
    smartAccount: z
      .object({
        factoryAddress: hexAddressSchema.optional(),
        implementationAddress: hexAddressSchema.optional(),
        entryPointAddress: hexAddressSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const cliConfigSchema = z
  .object({
    // ── Kash-orchestrated mode (API-backed) ─────────────────────────────
    apiKey: z
      .string()
      .startsWith('kash_', 'API keys start with "kash_"')
      .min(16, 'API key looks too short')
      .optional(),
    baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
    defaultChainId: z.number().int().positive().optional(),

    // ── Direct mode (`kash protocol …`, on-chain) ───────────────
    /** RPC endpoint for the chain. Consumer-owned; the CLI never proxies. */
    rpcUrl: z.string().url('rpcUrl must be a valid URL').optional(),
    /** Smart account address (the ERC-4337 account whose funds are used). */
    smartAccount: z
      .string()
      .regex(HEX_ADDRESS_REGEX, 'smartAccount must be a 0x-prefixed 40-char hex address')
      .optional(),
    /** Bundler URL (overrides the protocol-sdk's Flashbots Protect default). */
    bundlerUrl: z.string().url('bundlerUrl must be a valid URL').optional(),
    /** Bundler provider preset (selects the right header dialect). */
    bundlerProvider: bundlerProviderSchema.optional(),
    /** Reference to the EOA private key that owns the smart account. */
    signerKeyRef: signerKeyRefSchema.optional(),
    /**
     * Custom-chain addresses for chains outside the static registry
     * (local Anvil, forks, sidechains). When present, the CLI's
     * direct-mode and EOA-mode commands use these addresses instead
     * of looking the chain up in the registry. Required for chainId
     * 31337 (Anvil); optional for Base mainnet/testnet (registry covers them).
     */
    customChain: customChainSchema.optional(),
  })
  .strict();

export type CliConfig = z.infer<typeof cliConfigSchema>;

/**
 * Schema for the v1 multi-profile file shape.
 *
 * `currentProfile` is intentionally optional (no `.default()`) so the
 * source-attribution logic in `pickProfileName` can distinguish
 * "user explicitly persisted `default` via `kash config use default`"
 * (source: 'file') from "we fell through to the built-in default
 * because the file didn't carry a `currentProfile` field" (source:
 * 'default'). Both result in `'default'` as the active profile, but
 * the source attribution they report is different.
 */
const cliFileSchema = z
  .object({
    version: z.literal(1),
    currentProfile: profileNameSchema.optional(),
    profiles: z.record(profileNameSchema, cliConfigSchema).default({}),
  })
  .strict();

export type CliFile = z.infer<typeof cliFileSchema>;

/**
 * Canonical API base URLs by environment. The CLI auto-routes based on
 * the API-key prefix: a `kash_test_*` key targets staging, a
 * `kash_live_*` key (or no key) targets production. An explicit
 * `baseUrl` config or `KASH_BASE_URL` env var always wins so consumers
 * can target a private mirror, a local mock, or a future region.
 *
 * Mirrors the `inferBaseUrlFromApiKey()` logic in `@kashdao/sdk`'s
 * `internal/config.ts` so the CLI and the SDK route a given key to the
 * same environment without the user having to configure two places.
 */
export const PRODUCTION_BASE_URL = 'https://api.kash.bot/v1' as const;
export const STAGING_BASE_URL = 'https://api-staging.kash.bot/v1' as const;

/**
 * Derive the API base URL from an API key when neither config nor env
 * sets one explicitly. Returns `undefined` if the key shape isn't
 * recognised — the caller then falls back to {@link DEFAULTS.baseUrl}.
 */
export function inferBaseUrlFromApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.startsWith('kash_test_')) return STAGING_BASE_URL;
  if (apiKey.startsWith('kash_live_')) return PRODUCTION_BASE_URL;
  return undefined;
}

/** Default values applied when a field is missing from both file and env. */
export const DEFAULTS = {
  baseUrl: PRODUCTION_BASE_URL,
  defaultChainId: 8453,
} as const;

export type ResolvedConfig = {
  // ── Kash-orchestrated fields ──────────────────────────────────────────
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly defaultChainId: number;
  // ── Direct-mode fields (`kash protocol …`) ────────────────────
  readonly rpcUrl: string | undefined;
  readonly smartAccount: string | undefined;
  readonly bundlerUrl: string | undefined;
  readonly bundlerProvider: 'flashbots' | 'pimlico' | 'alchemy' | 'generic' | undefined;
  readonly signerKeyRef: string | undefined;
  /**
   * Custom-chain config — present only when the profile explicitly sets
   * `customChain.*`. Bypasses the protocol-sdk's static chain registry
   * and is required for chains the registry doesn't cover (Anvil,
   * forks, sidechains).
   */
  readonly customChain: CliConfig['customChain'];
  // ── Meta ──────────────────────────────────────────────────────
  /** Active profile name. */
  readonly profile: string;
  /** Where each non-default value came from — useful for `kash config show`. */
  readonly sources: {
    readonly apiKey: 'env' | 'file' | 'unset';
    readonly baseUrl: 'env' | 'file' | 'inferred' | 'default';
    readonly defaultChainId: 'env' | 'file' | 'default';
    readonly profile: 'flag' | 'env' | 'file' | 'default';
    readonly rpcUrl: 'env' | 'file' | 'unset';
    readonly smartAccount: 'env' | 'file' | 'unset';
    readonly bundlerUrl: 'env' | 'file' | 'unset';
    readonly bundlerProvider: 'env' | 'file' | 'unset';
    readonly signerKeyRef: 'env' | 'file' | 'unset';
    readonly customChain: 'file' | 'unset';
  };
};

export type ReadConfigOptions = {
  /** Override which profile to read; takes precedence over env + file. */
  readonly profile?: string;
  /** Override the config file path; takes precedence over `KASH_CONFIG`. */
  readonly configPath?: string;
};

/**
 * Read the config file and return the resolved active profile merged
 * with environment variables and defaults.
 */
export async function readConfig(opts: ReadConfigOptions = {}): Promise<ResolvedConfig> {
  const paths = resolveConfigPathsForOverride(opts.configPath);
  const file = await readFileConfig(paths);
  return resolveActive(file, opts.profile);
}

async function readFileConfig(paths: ConfigPaths): Promise<CliFile> {
  if (!existsSync(paths.file)) return emptyFile();
  let raw: string;
  try {
    raw = await readFile(paths.file, 'utf8');
  } catch (cause) {
    throw new CliConfigurationError(
      `Failed to read config file at ${paths.file}: ${(cause as Error).message}`,
      "Run 'kash config reset' to start fresh."
    );
  }
  return parseFileContents(raw, paths.file);
}

function parseFileContents(raw: string, file: string): CliFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CliConfigurationError(
      `Config file at ${file} is not valid JSON: ${(cause as Error).message}`,
      "Run 'kash config reset' to overwrite it with defaults."
    );
  }
  // Guard against valid-JSON-but-wrong-top-level (e.g. someone wrote
  // a string, a number, an array, or `null` to the file). Without this,
  // the v1 schema's "Expected object, received string" Zod error
  // bubbles up with no actionable hint.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliConfigurationError(
      `Config file at ${file} must contain a JSON object at the top level (got ${describeJsonRoot(parsed)}).`,
      "Run 'kash config reset' to overwrite it with defaults."
    );
  }
  const migrated = migrateLegacyShape(parsed);
  const result = cliFileSchema.safeParse(migrated);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '(root)';
    throw new CliConfigurationError(
      `Config file at ${file} is invalid (${path}): ${first?.message ?? 'validation failed'}`,
      "Run 'kash config reset' to overwrite it with defaults."
    );
  }
  return result.data;
}

/** Describe a non-object JSON root for the user-facing error message. */
function describeJsonRoot(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * If the file looks like the legacy flat shape ({ apiKey?, baseUrl?,
 * defaultChainId? } at the root), wrap it as the default profile of a
 * v1 file. Otherwise pass through.
 */
function migrateLegacyShape(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }
  const obj = parsed as Record<string, unknown>;
  if ('version' in obj || 'profiles' in obj) {
    return parsed; // already in v1 shape
  }
  // Legacy flat shape — wrap it as the default profile.
  const flat = cliConfigSchema.safeParse(obj);
  if (!flat.success) {
    return parsed; // let the v1 schema raise the structured error
  }
  return {
    version: 1,
    currentProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: flat.data },
  };
}

function emptyFile(): CliFile {
  return cliFileSchema.parse({ version: 1 });
}

/**
 * Compute the active profile name. Order: explicit flag > env >
 * file's `currentProfile` (when present) > built-in `'default'`.
 *
 * Crucially, when the file persists `currentProfile: "default"`
 * (e.g. after `kash config use default`), source is `'file'` — not
 * `'default'`. That keeps the JSON contract honest: agents debugging
 * "why is my profile X?" need to know it came from a write, not a
 * fallback.
 */
function pickProfileName(
  file: CliFile,
  flagOverride: string | undefined
): { name: string; source: 'flag' | 'env' | 'file' | 'default' } {
  if (flagOverride !== undefined) {
    validateProfileName(flagOverride, '--profile flag');
    return { name: flagOverride, source: 'flag' };
  }
  const env = process.env['KASH_PROFILE'];
  if (env !== undefined && env.length > 0) {
    validateProfileName(env, 'KASH_PROFILE environment variable');
    return { name: env, source: 'env' };
  }
  if (file.currentProfile !== undefined) {
    return { name: file.currentProfile, source: 'file' };
  }
  return { name: DEFAULT_PROFILE, source: 'default' };
}

/**
 * Wrap `profileNameSchema.parse` so a malformed value surfaces as a
 * typed `CliConfigurationError` with a `check_input`-friendly
 * suggestion, instead of a raw `ZodError` that the top-level
 * boundary maps to `UNEXPECTED`.
 */
function validateProfileName(value: string, source: string): void {
  const result = profileNameSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new CliConfigurationError(
      `Profile name from ${source} is invalid: ${issue?.message ?? 'validation failed'}.`,
      'Profile names accept letters, digits, underscore, dot, and dash; must be 1-64 characters.'
    );
  }
}

function resolveActive(file: CliFile, flagOverride: string | undefined): ResolvedConfig {
  const { name: profileName, source: profileSource } = pickProfileName(file, flagOverride);
  const profile = file.profiles[profileName];
  // It's not an error to ask for a profile that isn't in the file —
  // env-only setups (CI, agents) are normal. We surface this via the
  // `sources.apiKey === 'unset'` value if no env var fills the gap.
  //
  // BUT: when the missing profile was named via `KASH_PROFILE` or
  // `--profile`, an intentional env-only setup is the rare case and
  // a typo (e.g. `KASH_PROFILE=staing` vs `staging`) is the common
  // case. The operator otherwise sees an empty config + a confusing
  // `AUTH_REQUIRED` later. Nudge them on stderr (no JSON pollution,
  // no behaviour change). `KASH_QUIET=1` mutes the warning for CI.
  if (
    profile === undefined &&
    (profileSource === 'env' || profileSource === 'flag') &&
    Object.keys(file.profiles).length > 0 &&
    !isTruthyEnv(process.env['KASH_QUIET'])
  ) {
    const known = Object.keys(file.profiles).sort().join(', ');
    const sourceLabel = profileSource === 'env' ? 'KASH_PROFILE' : '--profile';
    process.stderr.write(
      `\u26a0  Profile "${profileName}" (${sourceLabel}) is not in the config file. ` +
        `Known profiles: ${known}. ` +
        `Did you typo the name? (Set KASH_QUIET=1 to mute this warning.)\n`
    );
  }
  return mergeWithEnv(profile ?? {}, profileName, profileSource);
}

/** Same truthy-env recognizer as `utils/global-options.ts:isTruthyEnv`. */
function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function mergeWithEnv(
  profile: CliConfig,
  profileName: string,
  profileSource: 'flag' | 'env' | 'file' | 'default'
): ResolvedConfig {
  const envApiKey = process.env['KASH_API_KEY'];
  const envBaseUrl = process.env['KASH_BASE_URL'];
  const envChainIdRaw = process.env['KASH_CHAIN_ID'];
  // Direct-mode env vars
  const envRpcUrl = process.env['KASH_RPC_URL'];
  const envSmartAccount = process.env['KASH_SMART_ACCOUNT'];
  const envBundlerUrl = process.env['KASH_BUNDLER_URL'];
  const envBundlerProviderRaw = process.env['KASH_BUNDLER_PROVIDER'];
  const envSignerKeyRef = process.env['KASH_SIGNER_KEY_REF'];

  let envChainId: number | undefined;
  if (envChainIdRaw !== undefined) {
    const n = Number.parseInt(envChainIdRaw, 10);
    if (Number.isNaN(n) || n <= 0) {
      throw new CliConfigurationError(
        `KASH_CHAIN_ID is not a positive integer: ${envChainIdRaw}`,
        'Set KASH_CHAIN_ID to a chain id like 8453 or 84532, or unset it to use the default.'
      );
    }
    envChainId = n;
  }

  let envBundlerProvider: ResolvedConfig['bundlerProvider'];
  if (envBundlerProviderRaw !== undefined) {
    const allowed = ['flashbots', 'pimlico', 'alchemy', 'generic'] as const;
    if (!(allowed as readonly string[]).includes(envBundlerProviderRaw)) {
      throw new CliConfigurationError(
        `KASH_BUNDLER_PROVIDER must be one of ${allowed.join(', ')} (got "${envBundlerProviderRaw}").`,
        'Unset the variable or set it to a supported preset.'
      );
    }
    envBundlerProvider = envBundlerProviderRaw as ResolvedConfig['bundlerProvider'];
  }

  const apiKey = envApiKey ?? profile.apiKey;
  // Resolution order for `baseUrl`:
  //   1. KASH_BASE_URL env var       — always wins
  //   2. profile.baseUrl             — explicit profile config
  //   3. inferred from apiKey prefix — kash_test_* → staging, kash_live_* → production
  //   4. DEFAULTS.baseUrl            — production (final fallback)
  //
  // Step 3 mirrors `@kashdao/sdk`'s `inferBaseUrlFromApiKey()` so the
  // CLI and the SDK route the same key to the same environment without
  // requiring the user to configure two places. Without this, a user
  // with only a `kash_test_*` key would hit production (and a DNS error
  // pre-launch) until they remembered to also set `--base-url`.
  const baseUrl =
    envBaseUrl ?? profile.baseUrl ?? inferBaseUrlFromApiKey(apiKey) ?? DEFAULTS.baseUrl;
  const defaultChainId = envChainId ?? profile.defaultChainId ?? DEFAULTS.defaultChainId;
  const rpcUrl = envRpcUrl ?? profile.rpcUrl;
  const smartAccount = envSmartAccount ?? profile.smartAccount;
  const bundlerUrl = envBundlerUrl ?? profile.bundlerUrl;
  const bundlerProvider = envBundlerProvider ?? profile.bundlerProvider;
  const signerKeyRef = envSignerKeyRef ?? profile.signerKeyRef;
  // customChain has no env-var override — it's a structured object,
  // not a single string, and the right place to set it is `kash
  // config set customChain.<leaf>` so partial sets compose. CI use
  // cases that need a custom chain mount the config file directly
  // (KASH_CONFIG=...).
  const customChain = profile.customChain;

  return {
    apiKey,
    baseUrl,
    defaultChainId,
    rpcUrl,
    smartAccount,
    bundlerUrl,
    bundlerProvider,
    signerKeyRef,
    customChain,
    profile: profileName,
    sources: {
      apiKey: envApiKey ? 'env' : profile.apiKey ? 'file' : 'unset',
      baseUrl: envBaseUrl
        ? 'env'
        : profile.baseUrl
          ? 'file'
          : inferBaseUrlFromApiKey(apiKey)
            ? 'inferred'
            : 'default',
      defaultChainId:
        envChainId !== undefined
          ? 'env'
          : profile.defaultChainId !== undefined
            ? 'file'
            : 'default',
      profile: profileSource,
      rpcUrl: envRpcUrl ? 'env' : profile.rpcUrl ? 'file' : 'unset',
      smartAccount: envSmartAccount ? 'env' : profile.smartAccount ? 'file' : 'unset',
      bundlerUrl: envBundlerUrl ? 'env' : profile.bundlerUrl ? 'file' : 'unset',
      bundlerProvider: envBundlerProvider ? 'env' : profile.bundlerProvider ? 'file' : 'unset',
      signerKeyRef: envSignerKeyRef ? 'env' : profile.signerKeyRef ? 'file' : 'unset',
      customChain: profile.customChain ? 'file' : 'unset',
    },
  };
}

export type WriteConfigOptions = {
  /** Profile to write to. Defaults to the current active profile. */
  readonly profile?: string;
  /** Override the config file path. */
  readonly configPath?: string;
};

/**
 * Result of {@link updateConfig} / {@link clearConfigField}. Carries
 * the resolved profile name so callers can render an accurate
 * "wrote to profile X" message instead of guessing — important for
 * the JSON contract that `kash auth set-key --json` ships, since
 * `--profile` may be unset and we want to report the actually-written
 * profile (which falls back to the file's `currentProfile`).
 */
export type UpdateConfigResult = {
  readonly profile: string;
  readonly stored: CliConfig;
};

/**
 * Mutate (and persist) a single field of the active (or named) profile.
 * Used by `auth set-key`, `auth logout`, `config set`. Writes the file
 * with `0600` permissions.
 */
export async function updateConfig(
  patch: Partial<CliConfig>,
  opts: WriteConfigOptions = {}
): Promise<UpdateConfigResult> {
  const paths = resolveConfigPathsForOverride(opts.configPath);
  const file = await readFileConfig(paths);
  const profileName = opts.profile ?? file.currentProfile ?? DEFAULT_PROFILE;
  profileNameSchema.parse(profileName);
  const current = file.profiles[profileName] ?? {};
  const next = cliConfigSchema.parse({ ...current, ...patch });
  const updated: CliFile = {
    ...file,
    profiles: { ...file.profiles, [profileName]: next },
  };
  await writeFileConfig(paths, updated);
  return { profile: profileName, stored: next };
}

/** Wipe a single field from a profile (used by `auth logout`). */
export async function clearConfigField(
  field: keyof CliConfig,
  opts: WriteConfigOptions = {}
): Promise<UpdateConfigResult> {
  const paths = resolveConfigPathsForOverride(opts.configPath);
  const file = await readFileConfig(paths);
  const profileName = opts.profile ?? file.currentProfile ?? DEFAULT_PROFILE;
  const current = file.profiles[profileName] ?? {};
  if (!(field in current)) return { profile: profileName, stored: current };
  const next = cliConfigSchema.parse(omitKey(current, field));
  const updated: CliFile = {
    ...file,
    profiles: { ...file.profiles, [profileName]: next },
  };
  await writeFileConfig(paths, updated);
  return { profile: profileName, stored: next };
}

/** List every profile name present in the config file. */
export async function listProfiles(
  opts: { configPath?: string } = {}
): Promise<{ readonly current: string; readonly profiles: readonly string[] }> {
  const paths = resolveConfigPathsForOverride(opts.configPath);
  const file = await readFileConfig(paths);
  return {
    current: file.currentProfile ?? DEFAULT_PROFILE,
    profiles: Object.keys(file.profiles).sort(),
  };
}

/** Set the file's `currentProfile` field. Validates the name. */
export async function setCurrentProfile(
  name: string,
  opts: { configPath?: string } = {}
): Promise<CliFile> {
  profileNameSchema.parse(name);
  const paths = resolveConfigPathsForOverride(opts.configPath);
  const file = await readFileConfig(paths);
  const updated: CliFile = { ...file, currentProfile: name };
  await writeFileConfig(paths, updated);
  return updated;
}

/** Remove a named profile. Refuses to remove the active one. */
export async function deleteProfile(
  name: string,
  opts: { configPath?: string } = {}
): Promise<CliFile> {
  profileNameSchema.parse(name);
  const paths = resolveConfigPathsForOverride(opts.configPath);
  const file = await readFileConfig(paths);
  if (file.currentProfile === name) {
    throw new CliConfigurationError(
      `Cannot delete the active profile "${name}".`,
      'Switch to another profile first with `kash config use <name>`.'
    );
  }
  if (!(name in file.profiles)) {
    return file;
  }
  const updated: CliFile = { ...file, profiles: omitKey(file.profiles, name) };
  await writeFileConfig(paths, updated);
  return updated;
}

/** Delete the entire config file. Used by `config reset`. */
export async function deleteConfig(opts: { configPath?: string } = {}): Promise<void> {
  const paths = resolveConfigPathsForOverride(opts.configPath);
  if (!existsSync(paths.file)) return;
  await unlink(paths.file);
}

/**
 * Return the full multi-profile file as-is. Used by `kash config
 * export` to dump every profile (vs `readConfig` which resolves a
 * single active profile). When the file doesn't exist, returns an
 * empty file shape so callers don't have to special-case "no config
 * yet".
 */
export async function readWholeFile(opts: { configPath?: string } = {}): Promise<CliFile> {
  const paths = resolveConfigPathsForOverride(opts.configPath);
  return await readFileConfig(paths);
}

/**
 * Replace the entire on-disk file with the supplied shape. Used by
 * `kash config import`. Validates against the `cliFileSchema` to
 * prevent garbage from landing on disk.
 *
 * Caller-side concerns (merge vs. overwrite, redaction policy, etc.)
 * are handled in the import command — this helper is pure persistence.
 */
export async function writeWholeFile(
  file: CliFile,
  opts: { configPath?: string } = {}
): Promise<void> {
  const paths = resolveConfigPathsForOverride(opts.configPath);
  const validated = cliFileSchema.parse(file);
  await writeFileConfig(paths, validated);
}

/** Public re-export of the file-level schema for the import command. */
export { cliFileSchema };

async function writeFileConfig(paths: ConfigPaths, file: CliFile): Promise<void> {
  await ensureDir(paths.dir);
  // Use writeFile + chmod rather than writeFile({mode}) because the
  // mode flag only takes effect on first creation; rewrites would
  // keep the old (potentially looser) permissions.
  await writeFile(paths.file, JSON.stringify(file, null, 2), 'utf8');
  await chmodSafe(paths.file, 0o600);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmodSafe(dir, 0o700);
}

async function chmodSafe(target: string, mode: number | undefined): Promise<void> {
  if (mode === undefined) return;
  if (process.platform === 'win32') return;
  try {
    await chmod(target, mode);
  } catch {
    // chmod can fail on some filesystems (e.g. mounted FAT volumes,
    // network shares). Treat as best-effort — the user's data still
    // landed, we just couldn't tighten perms.
  }
}
