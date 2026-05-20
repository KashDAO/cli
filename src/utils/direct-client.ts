/**
 * Build a `@kashdao/protocol-sdk` `SmartAccountClient` from the active
 * profile's direct-mode config.
 *
 * **Lazy-loaded.** This module dynamically imports
 * `@kashdao/protocol-sdk` (and viem) inside `buildDirectClient` so
 * the Kash-orchestrated code paths (markets / trade / portfolio /
 * webhooks / health) keep their fast cold start. Touching this
 * module at the module-top level — even in a `type` import — would
 * pull viem into every `kash --version` invocation.
 *
 * The CLI exposes the protocol-sdk through a single namespace
 * (`kash protocol …`); every command in that namespace calls
 * `buildDirectClient` to get a configured client and routes through
 * it. Read-only commands (`balance`, `market`, `quote`) use a
 * `noopSigner` that throws if a write path tries to sign — a
 * structural guarantee that read commands cannot accidentally
 * authorise spend.
 */

import { CliError, EXIT_CODES } from '../errors.js';

import { readConfig, type CliConfig } from './config-store.js';
import { resolveCliCustomChain } from './custom-chain.js';
import { loadRawPrivateKey } from './signer-key.js';

// Type-only imports — TypeScript erases these at compile time, so
// the protocol-sdk's runtime (and viem) is NOT pulled in via these
// lines. The actual import happens lazily inside `buildDirectClient`
// and `loadSigner` via dynamic `import()`.
import type { GlobalOptions } from './global-options.js';
import type {
  CustomChain,
  SmartAccountClient,
  SmartAccountClientConfigInput,
  SmartAccountSignerAdapter,
} from '@kashdao/protocol-sdk';

/**
 * Build a configured `DirectClient`. Caller passes the global
 * options so `--profile` / `--config` selection works uniformly with
 * the Kash-orchestrated path.
 *
 * `requireSigner: false` (default) constructs a no-op signer that
 * throws if anything actually tries to sign — fine for read-only
 * commands. Pass `true` for write-path commands (`build`, `submit`,
 * `simulate-write`).
 */
export async function buildDirectClient(opts: {
  readonly globals?: GlobalOptions;
  readonly requireSigner?: boolean;
}): Promise<{
  readonly client: SmartAccountClient;
  readonly chainId: number;
  readonly smartAccount: `0x${string}`;
}> {
  const globals = opts.globals;
  const config = await readConfig({
    ...(globals?.profile === undefined ? {} : { profile: globals.profile }),
    ...(globals?.configPath === undefined ? {} : { configPath: globals.configPath }),
  });

  // Foundational fields — required for *any* direct-mode command.
  const rpc = globals?.baseUrl ?? config.rpcUrl;
  if (!rpc) {
    throw missingDirectConfig('rpcUrl', '--rpc-url or `kash config set rpcUrl <url>`');
  }
  if (!config.smartAccount) {
    throw missingDirectConfig(
      'smartAccount',
      '`kash config set smartAccount 0x…` (the ERC-4337 account address whose funds you trade with)'
    );
  }

  // Lazy-load — the dynamic import is the cold-start firewall.
  const { createSmartAccountClient } = await import('@kashdao/protocol-sdk');

  const signer = opts.requireSigner ? await loadSigner(config.signerKeyRef) : noopSigner();

  const bundlerConfig = resolveBundlerConfig(config);

  // If the profile has `customChain` configured, build the SDK
  // CustomChain (viem chain + protocol addresses + optional SA factory
  // config) so we work against chains outside the static registry —
  // local Anvil, forks, sidechains. SA mode requires
  // `customChain.smartAccount.{factory,implementation,entryPoint}`
  // when running on Anvil because anvil_setCode can't copy immutable
  // variables (the canonical permissionless.js SimpleAccount factory
  // relies on immutable EntryPoint binding) — see protocol-sdk's
  // TROUBLESHOOTING.md § AA23.
  const customChain = await maybeBuildCustomChain(config, rpc);
  if (customChain !== undefined && customChain.smartAccount === undefined) {
    throw missingDirectConfig(
      'customChain.smartAccount',
      'all three: `kash config set customChain.smartAccount.factoryAddress 0x…`, `customChain.smartAccount.implementationAddress 0x…`, `customChain.smartAccount.entryPointAddress 0x…` (SA mode requires the local SimpleAccount factory + EntryPoint addresses on a custom chain — Anvil deploys these to addresses that differ from the canonical permissionless.js defaults)'
    );
  }

  const client = createSmartAccountClient({
    chainId: config.defaultChainId,
    rpc,
    signer,
    ...(bundlerConfig === undefined ? {} : { bundler: bundlerConfig }),
    ...(customChain === undefined ? {} : { customChain }),
  });

  return {
    client,
    chainId: config.defaultChainId,
    smartAccount: config.smartAccount as `0x${string}`,
  };
}

/**
 * Read-only signer for commands that don't need to sign anything
 * (`kash protocol balance/market/quote`). The DirectClient
 * constructor requires a signer, but read paths never call
 * `signUserOpHash` — if something does, this implementation throws
 * with a clear "this is a CLI bug" message so the failure surfaces
 * during testing rather than silently producing a bad signature.
 */
function noopSigner(): SmartAccountSignerAdapter {
  return {
    ownerAddress: '0x0000000000000000000000000000000000000000',
    async signUserOpHash() {
      throw new CliError('CLI bug: read-only direct-mode command attempted to sign a UserOp.', {
        code: 'UNEXPECTED',
        suggestion:
          'File an issue at https://github.com/KashDAO/cli/issues — this should not happen.',
      });
    },
  };
}

/**
 * Load a signer from the configured `signerKeyRef`. Supports two
 * sources today, both delegated to `loadRawPrivateKey` for parity
 * with EOA-mode:
 *
 *   - `file:<path>`  — read the key from disk. POSIX file mode is
 *                       checked after a successful load; if the file
 *                       is readable by group or other, the CLI emits
 *                       a `chmod 600` warning (load is NOT refused —
 *                       advisory, like ssh and aws-cli).
 *   - `env:<NAME>`   — read the key from the named env var.
 *
 * Both return a `viem` `LocalAccount` wrapped via
 * `viemAccountSigner` from the protocol-sdk.
 */
async function loadSigner(ref: string | undefined): Promise<SmartAccountSignerAdapter> {
  const rawKey = await loadRawPrivateKey(ref);
  // Lazy-load viem and the signer adapter together — both pulled by
  // the same dynamic import boundary.
  const [{ privateKeyToAccount }, { viemAccountSigner }] = await Promise.all([
    import('viem/accounts'),
    import('@kashdao/protocol-sdk'),
  ]);
  return viemAccountSigner(privateKeyToAccount(rawKey));
}

/**
 * Translate the CLI's profile-level bundler config into the
 * protocol-sdk's `bundler` field. The protocol-sdk's structured
 * bundler config requires `url` for every preset (the URL for
 * `flashbots`/`pimlico`/`alchemy` is the provider's own RPC, not
 * the chain RPC). The CLI surfaces this constraint as a
 * configuration error rather than silently defaulting.
 */
function resolveBundlerConfig(
  config: Awaited<ReturnType<typeof readConfig>>
): SmartAccountClientConfigInput['bundler'] | undefined {
  if (config.bundlerProvider === undefined && config.bundlerUrl === undefined) {
    return undefined; // Use the protocol-sdk's default (Flashbots Protect).
  }
  if (config.bundlerProvider === undefined) {
    // URL only — treat as a generic bundler (string shorthand).
    return config.bundlerUrl;
  }
  // Provider preset — `url` is required by the protocol-sdk schema.
  if (config.bundlerUrl === undefined) {
    throw new CliError(
      `Direct-mode config: bundlerProvider="${config.bundlerProvider}" requires a bundlerUrl.`,
      {
        code: 'DIRECT_CONFIG_MISSING',
        suggestion:
          '`kash config set bundlerUrl <provider-rpc-url>` (e.g. https://api.pimlico.io/v2/8453/rpc?apikey=…)',
      }
    );
  }
  return {
    provider: config.bundlerProvider,
    url: config.bundlerUrl,
  };
}

/**
 * Build an SDK `CustomChain` from the profile's `customChain` config,
 * if any. The CLI never asks the user to hand-construct a viem Chain
 * — we synthesise one from `defaultChainId + rpcUrl + customChain.name`,
 * which is exactly what the local-anvil quickstart in
 * `packages/protocol-sdk/examples/local-anvil/` does inline.
 */
async function maybeBuildCustomChain(
  config: CliConfig,
  rpc: string
): Promise<CustomChain | undefined> {
  if (config.customChain === undefined) return undefined;
  if (config.defaultChainId === undefined) {
    throw missingDirectConfig(
      'defaultChainId',
      '`kash config set defaultChainId <id>` (required when customChain is set so the CLI can construct the viem chain)'
    );
  }
  return resolveCliCustomChain({
    customChain: config.customChain,
    chainId: config.defaultChainId,
    rpc,
  });
}

function missingDirectConfig(field: string, hint: string): CliError {
  return new CliError(`Direct-mode config missing: ${field}.`, {
    code: 'DIRECT_CONFIG_MISSING',
    exitCode: EXIT_CODES.GENERIC,
    suggestion: `Set ${field} via ${hint}.`,
    actions: [
      {
        type: 'check_input',
        field,
        description: hint,
      },
    ],
  });
}
