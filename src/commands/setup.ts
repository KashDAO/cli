/**
 * `kash setup` — first-run interactive wizard.
 *
 * Collapses what's normally a four-step onboarding into a single
 * guided flow:
 *   1. Open the dashboard URL so the user can issue an API key.
 *   2. Paste the key (validated for the `kash_` prefix).
 *   3. Pick a profile name (defaults to `default`).
 *   4. Verify connectivity via `kash health`.
 *   5. Optionally install shell completion.
 *
 * **Lazy-loaded.** `@inquirer/prompts` is heavy — the dynamic import
 * keeps it out of the cold path for `kash --version` and other
 * non-interactive invocations. The KashClient + completion modules
 * are also lazy.
 *
 * **Skippable.** Every prompt has a sensible default and `--yes`
 * accepts all defaults non-interactively (CI / automation). `--json`
 * emits a structured summary at the end so post-setup scripts can
 * verify state without re-reading the config file.
 */

import { Command } from 'commander';

import { CliError, toCliError } from '../errors.js';
import { readGlobals } from '../utils/global-options.js';
import { log, print, printJson, style } from '../utils/output.js';

import type { GlobalOptions } from '../utils/global-options.js';

const DASHBOARD_URL = 'https://kash.bot/settings/api-keys';

type SetupOptions = {
  yes?: boolean;
  apiKey?: string;
};

/**
 * Per-scope probe result. `'ok'` means the canary call succeeded;
 * `'denied'` means the API returned 403 / INSUFFICIENT_SCOPE for that
 * scope (the key is valid but doesn't carry the scope); `'unknown'`
 * means the probe failed for a non-scope reason (network, server
 * error) — we don't pretend to know.
 */
type ScopeProbeStatus = 'ok' | 'denied' | 'unknown';

/**
 * Output envelope when `--json` is set. Stable contract — agents and
 * provisioning scripts pin to it.
 */
type SetupResult = {
  ok: true;
  profile: string;
  authenticated: boolean;
  health: { ok: boolean; latencyMs?: number; status?: string; version?: string };
  /**
   * Best-effort scope detection from canary read calls. Each entry is
   * a granted/denied/unknown verdict for a named scope. Does NOT probe
   * write scopes (that'd require a real trade).
   */
  scopes: Record<string, ScopeProbeStatus>;
  completionInstalled: boolean;
};

export const setupCommand = new Command('setup')
  .description('Interactive first-run wizard: configure an API key, verify, install completion.')
  .option('-y, --yes', 'accept all defaults and skip optional prompts (non-interactive)')
  .option('--api-key <key>', 'pass the API key non-interactively (skips the prompt)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash setup
  $ kash setup --api-key kash_live_… --yes --json
  $ kash --profile staging setup --yes  # write to a named profile
  $ KASH_API_KEY=kash_live_… kash setup --yes  # picks up the env var

Notes:
  - Re-runnable. Existing profiles are updated, not duplicated.
  - --yes accepts every default and skips optional prompts (no shell
    completion install). Combine with --api-key for full automation.
  - Use the top-level --profile flag (\`kash --profile <name> setup\`)
    to write to a named profile non-interactively.
`
  )
  .action(async (options: SetupOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    try {
      const result = await runSetup(options, globals);
      if (globals.json) {
        printJson(result);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

async function runSetup(options: SetupOptions, globals: GlobalOptions): Promise<SetupResult> {
  const jsonMode = globals.json;
  // Lazy imports — see file header.
  const [{ confirm, input, password }, { updateConfig, setCurrentProfile }, { buildClient }] =
    await Promise.all([
      import('@inquirer/prompts'),
      import('../utils/config-store.js'),
      import('../utils/client.js'),
    ]);

  if (!jsonMode) {
    print('');
    print(style.bold('Kash CLI setup'));
    print(style.dim('Configure an API key, verify connectivity, install shell completion.'));
    print('');
  }

  // Resolve the API key. Precedence: --api-key flag → env → prompt.
  const envKey = process.env['KASH_API_KEY'];
  let apiKey: string;
  if (options.apiKey) {
    apiKey = options.apiKey;
    if (!jsonMode) log.info('Using --api-key from the command line.');
  } else if (envKey) {
    apiKey = envKey;
    if (!jsonMode) log.info('Using KASH_API_KEY from the environment.');
  } else if (options.yes) {
    throw new CliError('Cannot run --yes without an API key.', {
      code: 'INVALID_INPUT',
      recoverable: true,
      suggestion: `Pass --api-key <kash_…>, set KASH_API_KEY, or run \`kash setup\` without --yes. Issue a key at ${DASHBOARD_URL}.`,
    });
  } else {
    if (!jsonMode) {
      print(`Issue a key at ${style.cyan(DASHBOARD_URL)} (Ctrl-C to abort).`);
    }
    // Use the masked-input prompt — `input()` would echo every
    // keystroke to the terminal, defeating the protection that
    // `kash setup` should provide for fresh API keys (shoulder-
    // surfing, screen recording, scroll-back capture). The validation
    // shape is identical to the previous `input` call.
    apiKey = await password({
      message: 'Paste your API key:',
      mask: '*',
      validate: (value: string) => {
        const trimmed = value.trim();
        if (trimmed.length < 16) return 'API key looks too short.';
        if (!trimmed.startsWith('kash_')) return 'API keys start with "kash_".';
        return true;
      },
    });
    apiKey = apiKey.trim();
  }

  // Resolve the profile name. Precedence: top-level --profile flag →
  // interactive prompt → 'default'. We deliberately reuse the global
  // flag rather than declaring our own to avoid two profile flags
  // with subtly different semantics.
  let profile = globals.profile;
  if (profile === undefined && !options.yes) {
    profile = await input({
      message: 'Profile name:',
      default: 'default',
    });
  }
  profile = (profile ?? 'default').trim();

  // Persist. `updateConfig` handles the file IO, mode 0600, and Zod
  // validation. We only update apiKey — baseUrl/chain are inferred
  // from the key prefix on first request. Both calls thread the
  // global `--config <path>` override so `kash setup --config
  // /tmp/test.json` writes to the user-specified file rather than
  // silently falling back to ~/.kash/config.json.
  const writeOpts = {
    profile,
    ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
  };
  const written = await updateConfig({ apiKey }, writeOpts);
  await setCurrentProfile(
    written.profile,
    globals.configPath === undefined ? undefined : { configPath: globals.configPath }
  );

  if (!jsonMode) {
    log.success(`Saved API key to profile "${written.profile}".`);
  }

  // Verify connectivity. We pass the just-resolved profile so the
  // health check reads the key we just wrote (not whatever was the
  // active profile before).
  let healthOk = false;
  let healthLatency: number | undefined;
  let healthStatus: string | undefined;
  let healthVersion: string | undefined;
  try {
    const { client } = await buildClient({
      requireAuth: true,
      // Reuse the resolved globals but pin the profile to the one we
      // just wrote — otherwise a stale flag could cause us to verify
      // a different profile than the one we configured.
      globals: { ...globals, profile: written.profile },
    });
    const result = await client.healthCheck();
    healthOk = result.ok;
    healthLatency = result.latencyMs;
    healthStatus = result.status;
    healthVersion = result.version;
    if (!jsonMode) {
      if (healthOk) {
        log.success(
          `Health check OK in ${String(healthLatency)}ms${
            healthVersion ? ` (server ${healthVersion})` : ''
          }.`
        );
      } else {
        log.warn('Health check returned not-ok. Verify your network or rerun later.');
      }
    }
  } catch (cause) {
    // Don't fail setup on a flaky health check — the key may still be
    // good and the user just has temporary connectivity issues.
    if (!jsonMode) {
      log.warn(`Health check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      log.info('Setup completed; verify later with `kash health`.');
    }
  }

  // Probe a handful of read scopes via canary calls. We don't probe
  // write scopes (that'd require a real trade or webhook rotation),
  // and we don't fail setup on probe errors — the key still works,
  // we just couldn't tell which scopes it carries.
  const scopes = await probeReadScopes({ globals, profile: written.profile });
  if (!jsonMode) {
    renderScopesHuman(scopes);
  }

  // Optional: shell completion. Skip in --yes mode (no good default
  // for an action that mutates the user's shell rc files).
  let completionInstalled = false;
  if (!options.yes && !jsonMode) {
    const detectedShell = process.env['SHELL'] ?? '(unknown)';
    const wantCompletion = await confirm({
      message: `Install shell completion for ${detectedShell}?`,
      default: true,
    });
    if (wantCompletion) {
      try {
        const { default: omelette } = await import('omelette');
        const completion = omelette('kash');
        completion.setupShellInitFile();
        completionInstalled = true;
        log.success('Shell completions installed.');
        log.info('Restart your shell or source your shell config to activate.');
      } catch (cause) {
        log.warn(
          `Could not install completion: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
    }
  }

  if (!jsonMode) {
    print('');
    print(style.bold("You're all set."));
    // Pick a "Try:" suggestion the user's key actually has scope for.
    // Pre-fix this was hardcoded to `markets list --status ACTIVE`,
    // which fails immediately for keys that only carry webhooks-read
    // / trades-read scope. Probe results drive the suggestion now.
    for (const line of pickNextStepHints(scopes)) {
      print(`  ${style.dim('Try:')} ${line}`);
    }
    print(`  ${style.dim('    :')} kash docs --json --quiet | jq '.subcommands[].name'`);
    print('');
  }

  return {
    ok: true,
    profile: written.profile,
    authenticated: true,
    health: {
      ok: healthOk,
      ...(healthLatency === undefined ? {} : { latencyMs: healthLatency }),
      ...(healthStatus === undefined ? {} : { status: healthStatus }),
      ...(healthVersion === undefined ? {} : { version: healthVersion }),
    },
    scopes,
    completionInstalled,
  };
}

/**
 * Probe-derived scope detection.
 *
 * Each named scope is mapped to a canary SDK call. We invoke the call
 * with a minimal pageSize and inspect the failure mode to classify:
 *
 *   - call resolves              → `'ok'` (scope present)
 *   - throws KashAuthorizationError(INSUFFICIENT_SCOPE) → `'denied'`
 *   - throws anything else       → `'unknown'` (probe inconclusive,
 *     don't claim the scope is missing)
 *
 * Read-only by design — write scopes (`trades:create`, `auth:manage`)
 * would require either a real mutation or a sentinel "what scopes do
 * I have?" endpoint, which the API doesn't currently expose.
 */
async function probeReadScopes(opts: {
  globals: GlobalOptions;
  profile: string;
}): Promise<Record<string, ScopeProbeStatus>> {
  const { buildClient } = await import('../utils/client.js');
  const { client } = await buildClient({
    requireAuth: true,
    globals: { ...opts.globals, profile: opts.profile },
  });

  // Each canary is a (scope-name, call) pair. Call uses limit:1 to
  // minimise server load. Order is stable so the JSON envelope is
  // pinnable.
  const probes: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['markets:read', async () => client.markets.list({ limit: 1 })],
    ['trades:read', async () => client.trades.list({ limit: 1 })],
    ['webhooks:read', async () => client.webhooks.list({ limit: 1 })],
  ];

  const result: Record<string, ScopeProbeStatus> = {};
  for (const [scope, call] of probes) {
    result[scope] = await classifyProbe(call);
  }
  return result;
}

async function classifyProbe(call: () => Promise<unknown>): Promise<ScopeProbeStatus> {
  try {
    await call();
    return 'ok';
  } catch (cause) {
    // The SDK's KashAuthorizationError carries `code: 'INSUFFICIENT_SCOPE'`.
    // We duck-type rather than import the class to avoid a dependency
    // on the SDK's class identity (an instanceof check would couple
    // to the exact module-graph copy of @kashdao/sdk).
    if (cause !== null && typeof cause === 'object') {
      const code = (cause as { code?: unknown }).code;
      if (code === 'INSUFFICIENT_SCOPE') return 'denied';
    }
    return 'unknown';
  }
}

function renderScopesHuman(scopes: Record<string, ScopeProbeStatus>): void {
  const entries = Object.entries(scopes);
  if (entries.length === 0) return;
  const allOk = entries.every(([, v]) => v === 'ok');
  if (allOk) {
    log.success('Scope check OK — key carries every probed read scope.');
    return;
  }
  log.info('Scope detection (probed via canary read calls):');
  for (const [scope, status] of entries) {
    const label =
      status === 'ok'
        ? style.success('granted')
        : status === 'denied'
          ? style.warn('not granted')
          : style.dim('inconclusive');
    print(`  ${style.dim(scope.padEnd(16))} ${label}`);
  }
  const denied = entries.filter(([, v]) => v === 'denied').map(([k]) => k);
  if (denied.length > 0) {
    log.info(
      `Issue a key with broader scope at https://kash.bot/settings/api-keys if you need: ${denied.join(', ')}.`
    );
  }
}

/**
 * Pick `kash <…>` suggestions to surface in the post-setup banner,
 * gated on the scopes the probe confirmed. Order from most-common
 * to least-common; emit at most 2 lines so the banner stays terse.
 *
 * Falls back to a generic "see `kash --help`" when no probed scope
 * looks usable (rare — the probe already errored loudly in that
 * case, but we keep the wizard's last line useful regardless).
 */
function pickNextStepHints(scopes: Record<string, ScopeProbeStatus>): readonly string[] {
  const hints: string[] = [];
  if (scopes['markets:read'] === 'ok') {
    hints.push('kash markets list --status ACTIVE');
  }
  if (scopes['trades:read'] === 'ok') {
    hints.push('kash trade list --json --quiet | jq -r ".data[].id"');
  }
  if (scopes['webhooks:read'] === 'ok' && hints.length < 2) {
    hints.push('kash webhooks list --status failed,retrying');
  }
  if (hints.length === 0) {
    // Probe results were inconclusive or every read scope was denied.
    // The earlier `renderScopesHuman` already surfaced the per-scope
    // verdict; keep the banner non-actionable instead of pointing at
    // a command that 403s.
    hints.push('kash --help');
  }
  return hints.slice(0, 2);
}
