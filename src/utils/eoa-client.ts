/**
 * Build a `@kashdao/protocol-sdk` `EoaClient` from the active
 * profile's direct-mode config.
 *
 * EOA mode is the parallel non-custodial path to smart-account mode
 * (`buildDirectClient` in `direct-client.ts`). It signs vanilla
 * EIP-1559 transactions instead of UserOps; the signer's address IS
 * the trading account. Required config:
 *
 *   - `rpcUrl`        — same field as SA mode
 *   - `signerKeyRef`  — same field as SA mode (file: or env:)
 *   - `defaultChainId` — same field as SA mode
 *
 * EOA mode does NOT need:
 *   - `smartAccount` (the EOA address is derived from the signer)
 *   - `bundlerUrl` / `bundlerProvider` (no bundler involvement)
 *
 * **Lazy-loaded.** Same cold-start firewall as `direct-client.ts` —
 * the dynamic `import('@kashdao/protocol-sdk')` keeps viem out of the
 * non-EOA paths.
 */

import { CliError, EXIT_CODES } from '../errors.js';

import { readConfig } from './config-store.js';
import { loadRawPrivateKey } from './signer-key.js';

import type { GlobalOptions } from './global-options.js';
import type { EoaClient, EoaSignerAdapter } from '@kashdao/protocol-sdk';

/**
 * Build a configured `EoaClient`. `requireSigner` is always `true`
 * here — there's no read-only EOA mode (the signer address is the
 * trading account, and reads need the address). Reads against an
 * arbitrary address are still possible by passing the address as a
 * positional argument; the signer just provides the default.
 */
export async function buildEoaClient(opts: { readonly globals?: GlobalOptions }): Promise<{
  readonly client: EoaClient;
  readonly chainId: number;
  readonly account: `0x${string}`;
}> {
  const globals = opts.globals;
  const config = await readConfig({
    ...(globals?.profile === undefined ? {} : { profile: globals.profile }),
    ...(globals?.configPath === undefined ? {} : { configPath: globals.configPath }),
  });

  const rpc = globals?.baseUrl ?? config.rpcUrl;
  if (!rpc) {
    throw missingEoaConfig('rpcUrl', '--rpc-url or `kash config set rpcUrl <url>`');
  }
  if (!config.signerKeyRef) {
    throw missingEoaConfig(
      'signerKeyRef',
      '`kash config set signerKeyRef file:<path>` or `env:<NAME>` (CLI never persists raw keys)'
    );
  }

  const { createEoaClient } = await import('@kashdao/protocol-sdk');
  const signer = await loadEoaSigner(config.signerKeyRef);

  const client = createEoaClient({
    chainId: config.defaultChainId,
    rpc,
    signer,
  });

  return {
    client,
    chainId: config.defaultChainId,
    account: signer.ownerAddress,
  };
}

/**
 * Load an EOA signer from `signerKeyRef`. Mirrors the SA-mode
 * `loadSigner` in `direct-client.ts` but wraps via
 * `viemAccountEoaSigner` for vanilla-tx signing instead of
 * `viemAccountSigner` for UserOp hash signing.
 */
async function loadEoaSigner(ref: string): Promise<EoaSignerAdapter> {
  const rawKey = await loadRawPrivateKey(ref);
  // Lazy-load viem + the EOA signer adapter together (matches the
  // SA-mode boundary in `direct-client.ts`). Different adapter, same
  // dynamic-import gate.
  const [{ privateKeyToAccount }, { viemAccountEoaSigner }] = await Promise.all([
    import('viem/accounts'),
    import('@kashdao/protocol-sdk'),
  ]);
  return viemAccountEoaSigner(privateKeyToAccount(rawKey));
}

function missingEoaConfig(field: string, hint: string): CliError {
  return new CliError(`EOA-mode config missing: ${field}.`, {
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
