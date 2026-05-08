/**
 * `kash auth status` — report the locally-stored credentials.
 *
 * Does NOT call the API. There is no `whoami` endpoint on the public
 * API today (the only auth-flavoured route is webhook-secret rotation,
 * which is a write). Reporting purely-local state keeps the command
 * cheap and side-effect-free; the moment the user issues a real call
 * (e.g. `kash markets list`) the SDK raises `KashAuthenticationError`
 * if the key is invalid.
 */

import { Command } from 'commander';

import { readConfig } from '../../utils/config-store.js';
import { redact } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

export const statusCommand = new Command('status')
  .description('Show locally-configured credentials. Does not call the API.')
  .addHelpText(
    'after',
    `
Examples:
  $ kash auth status
  $ kash auth status --profile prod
  $ kash auth status --json --quiet | jq -r '.apiKey'
`
  )
  .action(async (_opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    const config = await readConfig({
      ...(globals.profile === undefined ? {} : { profile: globals.profile }),
      ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
    });

    if (globals.json) {
      printJson({
        // Pure local-state field. `true` means "an API key is in
        // scope for this profile" (file or env), NOT "this key is
        // accepted by the server" — `kash auth status` is offline by
        // design. Use `kash health --json --quiet | jq .ok` for a
        // server-side check.
        configured: Boolean(config.apiKey),
        // Backward-compat alias. Same value as `configured`. Kept
        // for downstream scripts that pin to the old field name —
        // will be removed in a major bump after the rename has
        // burned in.
        authenticated: Boolean(config.apiKey),
        apiKey: config.apiKey ? redact(config.apiKey) : null,
        profile: config.profile,
        baseUrl: config.baseUrl,
        defaultChainId: config.defaultChainId,
        // Direct-mode fields (`kash protocol …` / `kash eoa …`). Always
        // emitted (`null` when unset) so direct-mode operators can
        // introspect their own profile via JSON without falling back
        // to reading `~/.kash/config.json` directly. The signerKeyRef
        // is the reference shape (`file:<path>` / `env:<NAME>`),
        // never the raw private key — the CLI never persists keys.
        rpcUrl: config.rpcUrl ?? null,
        smartAccount: config.smartAccount ?? null,
        bundlerUrl: config.bundlerUrl ?? null,
        bundlerProvider: config.bundlerProvider ?? null,
        signerKeyRef: config.signerKeyRef ?? null,
        sources: config.sources,
      });
      return;
    }

    if (!config.apiKey) {
      log.warn(`No API key configured for profile "${config.profile}".`);
      log.detail(
        'Hint',
        "Run 'kash setup' for the wizard, or 'kash auth set-key' for the bare key. Or set KASH_API_KEY."
      );
      return;
    }

    print(`${style.success('✓')} API key configured (profile: ${config.profile})`);
    print(
      `  ${style.dim('Note      ')} not verified against the server — run \`kash health\` to probe`
    );
    print(`  ${style.dim('API key   ')} ${redact(config.apiKey)} (${config.sources.apiKey})`);
    print(`  ${style.dim('Profile   ')} ${config.profile} (${config.sources.profile})`);
    print(`  ${style.dim('Base URL  ')} ${config.baseUrl} (${config.sources.baseUrl})`);
    print(
      `  ${style.dim('Chain id  ')} ${String(config.defaultChainId)} (${config.sources.defaultChainId})`
    );
  });
