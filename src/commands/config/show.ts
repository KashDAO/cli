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
      // agents that bind one shape can consume the other. Direct-mode
      // fields are always emitted (`null` when unset) so operators
      // can introspect the full profile via JSON.
      printJson({
        profile: config.profile,
        authenticated: Boolean(config.apiKey),
        apiKey: config.apiKey ? redact(config.apiKey) : null,
        baseUrl: config.baseUrl,
        defaultChainId: config.defaultChainId,
        rpcUrl: config.rpcUrl ?? null,
        smartAccount: config.smartAccount ?? null,
        bundlerUrl: config.bundlerUrl ?? null,
        bundlerProvider: config.bundlerProvider ?? null,
        signerKeyRef: config.signerKeyRef ?? null,
        customChain: config.customChain ?? null,
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
    print(
      `  ${style.dim('Default chain  ')} ${String(config.defaultChainId)} (${config.sources.defaultChainId})`
    );
    // Surface direct-mode fields when any are set. Skip the section
    // entirely on a pure-custodial profile so human output stays terse.
    const hasDirectMode =
      config.rpcUrl !== undefined ||
      config.smartAccount !== undefined ||
      config.bundlerUrl !== undefined ||
      config.bundlerProvider !== undefined ||
      config.signerKeyRef !== undefined;
    if (hasDirectMode) {
      print('');
      print(`  ${style.dim('Direct mode    ')}`);
      print(
        `  ${style.dim('  RPC URL      ')} ${config.rpcUrl ?? '(unset)'} (${config.sources.rpcUrl})`
      );
      print(
        `  ${style.dim('  Smart account')} ${config.smartAccount ?? '(unset)'} (${config.sources.smartAccount})`
      );
      print(
        `  ${style.dim('  Bundler URL  ')} ${config.bundlerUrl ?? '(unset)'} (${config.sources.bundlerUrl})`
      );
      print(
        `  ${style.dim('  Bundler kind ')} ${config.bundlerProvider ?? '(unset)'} (${config.sources.bundlerProvider})`
      );
      print(
        `  ${style.dim('  Signer ref   ')} ${config.signerKeyRef ?? '(unset)'} (${config.sources.signerKeyRef})`
      );
    }

    // Custom-chain section — surfaces when the profile bypasses the
    // protocol-sdk's static chain registry (Anvil / forks / sidechains).
    if (config.customChain !== undefined) {
      const cc = config.customChain;
      print('');
      print(`  ${style.dim('Custom chain   ')} (${config.sources.customChain})`);
      print(`  ${style.dim('  Name         ')} ${cc.name}`);
      print(`  ${style.dim('  Factory      ')} ${cc.factoryAddress}`);
      print(`  ${style.dim('  USDC         ')} ${cc.usdcAddress}`);
      if (cc.oracleAddress) print(`  ${style.dim('  Oracle       ')} ${cc.oracleAddress}`);
      if (cc.vaultAddress) print(`  ${style.dim('  Vault        ')} ${cc.vaultAddress}`);
      if (cc.tokens1155Address) print(`  ${style.dim('  Tokens1155   ')} ${cc.tokens1155Address}`);
      if (cc.paramRegistryAddress)
        print(`  ${style.dim('  ParamRegistry')} ${cc.paramRegistryAddress}`);
      if (cc.smartAccount) {
        print(`  ${style.dim('  Smart account')}`);
        print(`  ${style.dim('    Factory    ')} ${cc.smartAccount.factoryAddress}`);
        print(`  ${style.dim('    Implement. ')} ${cc.smartAccount.implementationAddress}`);
        print(`  ${style.dim('    EntryPoint ')} ${cc.smartAccount.entryPointAddress}`);
      }
    }
  });
