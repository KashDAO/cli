/**
 * `kash version` — emit the full version manifest.
 *
 * The default Commander `--version` flag prints just the CLI version
 * as a bare string. That's right for humans (`kash --version` →
 * `0.1.0`) but useless for AI agents reporting issues, since they
 * also need to know which SDK, Node, OS, and arch they're running
 * against.
 *
 * `kash version --json` (and the equivalent `kash --version --json`
 * intercept in index.ts) emits a structured manifest with every
 * field an issue triage might want.
 */

import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';

import { Command } from 'commander';

import { readGlobals } from '../utils/global-options.js';
import { print, printJson, style } from '../utils/output.js';
import { CLI_VERSION } from '../version.js';

import type { CliCapability, VersionManifest } from '../cli-schemas.js';
import type { VersionCheckResult } from '../utils/version-check.js';

// Re-export the canonical types so call sites that import them from
// this file (e.g. agents importing `VersionManifest` alongside
// `buildVersionManifest`) keep working.
export type { CliCapability, VersionManifest };

/**
 * The capabilities this CLI release advertises. Each entry maps to a
 * documented feature in `cli-schemas.ts:CliCapabilitySchema`. Adding
 * a token is additive (consumers do containment checks); removing a
 * token is a SemVer-breaking event. Tokens that depend on a deferred
 * feature (e.g. `mcp-server`) are intentionally absent until the
 * feature ships — `kash version --json | jq '.capabilities | contains(["mcp-server"])'`
 * is the canonical agent feature-detection probe.
 */
const ADVERTISED_CAPABILITIES: readonly CliCapability[] = [
  'json-envelope',
  'json-quiet',
  'fields-projection',
  'filter-dsl',
  'ndjson-streaming',
  'kash-explain',
  'structured-actions',
  'trade-place',
  'protocol-trade',
  'eoa-trade',
  'protocol-userop',
  'protocol-watch',
  'partial-completion-records',
  'webhooks-replay',
  'webhooks-replay-dry-run',
  'webhooks-replay-refuse-private',
];

/**
 * Resolve the SDK version at runtime. Reads `@kashdao/sdk/package.json`
 * via Node's module resolution rather than re-exporting a constant
 * from the SDK so the value tracks whatever the consumer actually
 * has installed (handy for downstream npm publishes that pin to
 * different SDK versions across linked releases).
 */
function resolveSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@kashdao/sdk/package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildVersionManifest(): VersionManifest {
  return {
    cli: CLI_VERSION,
    sdk: resolveSdkVersion(),
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    capabilities: [...ADVERTISED_CAPABILITIES],
  };
}

type VersionOptions = {
  check?: boolean;
};

export const versionCommand = new Command('version')
  .description('Show CLI version and runtime environment.')
  .option('--check', 'probe npm for a newer @kashdao/cli release (cached for 24h)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash version
  $ kash version --json
  $ kash version --check               # check npm for a newer release
  $ kash version --check --json        # structured update info
  $ kash --version --json              # short alias for \`kash version --json\`

  # Agent feature detection — \`capabilities\` is an additive token list.
  $ kash version --json --quiet | jq '.capabilities | contains(["webhooks-replay-dry-run"])'
  $ kash version --json --quiet | jq -r '.capabilities[]'
`
  )
  .action(async (options: VersionOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const manifest = buildVersionManifest();

    // Lazy-load the version-check helper so the default `kash version`
    // path doesn't pay for the fetch + cache file IO.
    let updateInfo: VersionCheckResult | null = null;
    if (options.check) {
      const { checkLatestVersion } = await import('../utils/version-check.js');
      updateInfo = await checkLatestVersion(manifest.cli);
    }

    if (globals.json) {
      printJson({
        ...manifest,
        ...(updateInfo === null ? {} : { update: updateInfo }),
      });
      return;
    }
    print(`${style.bold('@kashdao/cli')}    ${manifest.cli}`);
    print(`${style.dim('@kashdao/sdk')}    ${manifest.sdk}`);
    print(`${style.dim('Node.js     ')}    ${manifest.node}`);
    print(
      `${style.dim('OS          ')}    ${manifest.platform} ${manifest.release} (${manifest.arch})`
    );
    if (manifest.capabilities && manifest.capabilities.length > 0) {
      print(
        `${style.dim('Capabilities')}    ${String(manifest.capabilities.length)} (\`kash version --json --quiet | jq -r '.capabilities[]'\` for the list)`
      );
    }

    if (updateInfo === null) return;
    if (updateInfo.isOutdated && updateInfo.latestVersion) {
      print('');
      print(
        `${style.warn('⚠')} A newer @kashdao/cli is available: ${style.bold(updateInfo.latestVersion)} (current: ${manifest.cli})`
      );
      print(`${style.dim('  Update with')} ${style.cyan('npm install -g @kashdao/cli@latest')}`);
    } else if (updateInfo.latestVersion) {
      print('');
      print(`${style.dim('You\u2019re on the latest @kashdao/cli release.')}`);
    } else {
      print('');
      print(`${style.dim('Could not reach npm to check for updates.')}`);
    }
  });
