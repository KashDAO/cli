/**
 * Translate the CLI's profile-level `customChain` config into the
 * `@kashdao/protocol-sdk` `CustomChain` shape (viem chain + protocol
 * addresses + optional smart-account factory config).
 *
 * The CLI never asks the user to hand-construct a viem Chain object —
 * we synthesise one from the profile's `defaultChainId + rpcUrl +
 * customChain.name`, matching what the
 * `packages/protocol-sdk/examples/local-anvil/` quickstarts do inline.
 *
 * This is the only place in the CLI that imports `viem.defineChain`.
 * The dynamic import keeps viem off the cold-start path for non-direct
 * commands (markets list / trade buy / portfolio / health all skip
 * this module).
 *
 * @module utils/custom-chain
 */

import { CliError, EXIT_CODES } from '../errors.js';

import type { CliConfig } from './config-store.js';
import type { CustomChain } from '@kashdao/protocol-sdk';

export type ResolveCustomChainOptions = {
  /** The profile's `customChain` block — required, validated by Zod upstream. */
  readonly customChain: NonNullable<CliConfig['customChain']>;
  /**
   * `defaultChainId` from the profile. Required at the call site (the
   * caller raises `DIRECT_CONFIG_MISSING` if missing) — we accept it
   * non-optional here so this helper is total.
   */
  readonly chainId: number;
  /**
   * RPC URL used to construct the viem chain's `rpcUrls.default.http`.
   * Same URL the CLI passes as the SDK's `rpc` field — duplicated
   * because the viem chain object carries its own RPC array for any
   * downstream callers that read from `chain.rpcUrls` rather than the
   * `transport`.
   */
  readonly rpc: string;
};

/**
 * Materialise a CustomChain. Use it like:
 *
 * ```ts
 * const customChain = await resolveCliCustomChain({ customChain, chainId, rpc });
 * createEoaClient({ ..., customChain });
 * ```
 *
 * The viem chain is given `Ether` as the native currency by default —
 * which is correct for every chain the protocol-sdk supports today
 * (Base + Anvil derivatives). If we ever launch on a chain whose
 * native currency isn't ETH-shaped, surface that as a separate
 * `customChain.nativeCurrency` config field; for now the constant
 * keeps the config minimal.
 */
export async function resolveCliCustomChain(opts: ResolveCustomChainOptions): Promise<CustomChain> {
  const { customChain, chainId, rpc } = opts;

  // Required-at-use validation. The persisted schema marks every field
  // optional so `kash config set customChain.<leaf>` can build the
  // object up one leaf at a time. The SDK's CustomChain shape requires
  // `name + addresses.factory + addresses.usdc`. We surface the
  // missing field here, where the consumer just tried to run an
  // `eoa`/`protocol` command, with the exact `kash config set` line
  // they need to fix it.
  if (customChain.name === undefined) {
    throw missingCustomChainField(
      'customChain.name',
      '`kash config set customChain.name "Anvil local"` (or whatever label you want surfaced on client.addresses.name)'
    );
  }
  if (customChain.factoryAddress === undefined) {
    throw missingCustomChainField(
      'customChain.factoryAddress',
      '`kash config set customChain.factoryAddress 0x…` (the deployed Kash factory address on this chain)'
    );
  }
  if (customChain.usdcAddress === undefined) {
    throw missingCustomChainField(
      'customChain.usdcAddress',
      '`kash config set customChain.usdcAddress 0x…` (the deployed USDC token address on this chain)'
    );
  }

  // Smart-account triple is all-or-nothing — surfacing each missing
  // leaf separately is more actionable than "smartAccount is incomplete".
  let smartAccount: CustomChain['smartAccount'];
  if (customChain.smartAccount !== undefined) {
    const sa = customChain.smartAccount;
    if (
      sa.factoryAddress !== undefined ||
      sa.implementationAddress !== undefined ||
      sa.entryPointAddress !== undefined
    ) {
      if (sa.factoryAddress === undefined) {
        throw missingCustomChainField(
          'customChain.smartAccount.factoryAddress',
          '`kash config set customChain.smartAccount.factoryAddress 0x…`'
        );
      }
      if (sa.implementationAddress === undefined) {
        throw missingCustomChainField(
          'customChain.smartAccount.implementationAddress',
          '`kash config set customChain.smartAccount.implementationAddress 0x…`'
        );
      }
      if (sa.entryPointAddress === undefined) {
        throw missingCustomChainField(
          'customChain.smartAccount.entryPointAddress',
          '`kash config set customChain.smartAccount.entryPointAddress 0x…`'
        );
      }
      smartAccount = {
        factoryAddress: sa.factoryAddress as `0x${string}`,
        implementationAddress: sa.implementationAddress as `0x${string}`,
        entryPointAddress: sa.entryPointAddress as `0x${string}`,
      };
    }
  }

  // Lazy-load viem so this module's import doesn't drag viem onto the
  // non-direct command paths. Same firewall pattern as the
  // `eoa-client.ts` / `direct-client.ts` `await import('@kashdao/protocol-sdk')`.
  const { defineChain } = await import('viem');

  return {
    name: customChain.name,
    viemChain: defineChain({
      id: chainId,
      name: customChain.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    }),
    addresses: {
      factory: customChain.factoryAddress as `0x${string}`,
      usdc: customChain.usdcAddress as `0x${string}`,
      ...(customChain.oracleAddress === undefined
        ? {}
        : { oracle: customChain.oracleAddress as `0x${string}` }),
      ...(customChain.vaultAddress === undefined
        ? {}
        : { vault: customChain.vaultAddress as `0x${string}` }),
      ...(customChain.tokens1155Address === undefined
        ? {}
        : { tokens1155: customChain.tokens1155Address as `0x${string}` }),
      ...(customChain.paramRegistryAddress === undefined
        ? {}
        : { paramRegistry: customChain.paramRegistryAddress as `0x${string}` }),
    },
    ...(smartAccount === undefined ? {} : { smartAccount }),
  };
}

function missingCustomChainField(field: string, hint: string): CliError {
  return new CliError(`Custom-chain config missing: ${field}.`, {
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
