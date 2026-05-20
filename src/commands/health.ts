/**
 * `kash health` — verify connectivity + key validity.
 *
 * Wraps the SDK's `KashClient.healthCheck`, which calls `GET /v1/health`
 * with a tight timeout and a single attempt (no retries — health
 * failures should be surfaced fast). The result is non-throwing: a
 * down server produces `ok: false`, not an exception, so scripts can
 * branch on the boolean without try/catch.
 *
 * Designed for two flows:
 *
 *   1. **Operator preflight** — run before a deploy or batch job to
 *      confirm reachability and tag agreement.
 *   2. **AI-agent startup** — call once at boot, fail fast if Kash
 *      is unreachable instead of mid-request.
 *
 * Exit code is `0` on `ok: true` and `1` on `ok: false`, so
 * `kash health || exit 1` is a valid one-liner gate.
 */

import { Command } from 'commander';

import { CliError, EXIT_CODES, toCliError } from '../errors.js';
import { buildClient } from '../utils/client.js';
import { readConfig } from '../utils/config-store.js';
import { readGlobals } from '../utils/global-options.js';
import { log, print, printJson, style } from '../utils/output.js';

/**
 * Build a recovery suggestion for a failed health check based on the
 * resolved base URL. The two common failure modes pre-mainnet-launch:
 *
 *   1. User has no API key set → CLI defaults to `api.kash.bot/v1`,
 *      which doesn't resolve until production deploys. Steer them at
 *      a test key (which auto-routes to staging via
 *      `inferBaseUrlFromApiKey`).
 *   2. User has a key but the host is genuinely unreachable (transient
 *      network issue, corporate proxy, DNS hiccup) → generic retry.
 */
function buildHealthFailureSuggestion(baseUrl: string): string {
  if (baseUrl.includes('api.kash.bot') && !baseUrl.includes('api-staging.kash.bot')) {
    return (
      'Production (`https://api.kash.bot/v1`) is not yet live. ' +
      'For staging, get a test key at https://app.kash.bot and run `kash setup ' +
      '--api-key kash_test_…` — the CLI auto-routes test keys to ' +
      '`https://api-staging.kash.bot/v1`. ' +
      'To pin a different host, pass `--base-url <url>` or set `KASH_BASE_URL`.'
    );
  }
  return `The configured API host (${baseUrl}) was not reachable. Check connectivity and retry.`;
}

export const healthCommand = new Command('health')
  .description(
    'Check connectivity to the Kash API. Exits 1 when not ok. Honors --timeout-ms (default 5000).'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash health
  $ kash health --json --quiet | jq -r '.ok'
  $ kash --timeout-ms 2000 health
  $ kash health || exit 1   # gate a script on reachability
`
  )
  .action(async (_opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    // Health-check default is tighter than the SDK's general 30s
    // default — failures should surface fast. The global
    // --timeout-ms still wins when set explicitly.
    const timeoutMs = globals.timeoutMs ?? 5000;

    let result;
    try {
      const { client } = await buildClient({ globals });
      result = await client.healthCheck({ timeoutMs });
    } catch (cause) {
      // The SDK's healthCheck only throws on caller-driven aborts
      // (KashAbortedError). Anything else is data, not an exception.
      throw toCliError(cause);
    }

    // **JSON-mode contract.** Always emit exactly ONE JSON object on
    // stdout — the previous code path emitted both the success-shape
    // `result` AND the error envelope on the !ok path, which broke
    // `jq` consumers. On the !ok path we throw a CliError with the
    // diagnostic data folded into `actions[]` so a single envelope
    // carries both the failure code and the latency / requestId
    // diagnostics.
    if (!result.ok) {
      // Resolve the config so the suggestion can reference the host the
      // CLI actually tried. Tolerate resolution failures (e.g. missing
      // config file) — fall back to a generic suggestion rather than
      // erroring inside an error handler.
      let suggestion = 'The Kash API was not reachable. Check connectivity and retry.';
      try {
        const cfg = await readConfig({
          ...(globals.profile === undefined ? {} : { profile: globals.profile }),
          ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
        });
        suggestion = buildHealthFailureSuggestion(cfg.baseUrl);
      } catch {
        // ignore — keep generic suggestion
      }

      if (globals.json) {
        // Throw a CliError that carries the diagnostic data in its
        // envelope. The top-level emitError handler will print
        // exactly one JSON object on stdout. We pre-load the
        // recoverable + suggestion fields here rather than in the
        // catalog so the runtime data (latencyMs, requestId) is
        // visible to the agent reading the envelope.
        throw new CliError(
          `Health check failed (${String(result.latencyMs)}ms elapsed${result.requestId === undefined ? '' : `, request ${result.requestId}`}).`,
          {
            code: 'NETWORK',
            recoverable: true,
            suggestion,
            exitCode: EXIT_CODES.GENERIC,
            ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
          }
        );
      }
      // Human mode: emit the error line + diagnostics on stderr,
      // then throw to drive the exit code through the top-level
      // emitError. The top-level handler prints the human error
      // footer on stderr too, so no stdout pollution.
      log.error(`Kash API not reachable. (${String(result.latencyMs)}ms elapsed)`);
      if (result.requestId !== undefined) {
        log.detail('Request ID', result.requestId);
      }
      throw new CliError('Health check failed.', {
        code: 'NETWORK',
        recoverable: true,
        suggestion,
        exitCode: EXIT_CODES.GENERIC,
      });
    }

    // ok path
    if (globals.json) {
      printJson(result);
      return;
    }
    const versionTag = result.version === undefined ? '' : ` (server ${result.version})`;
    print(`${style.success('✓')} Kash API reachable in ${String(result.latencyMs)}ms${versionTag}`);
  });
