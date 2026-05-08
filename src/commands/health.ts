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
import { readGlobals } from '../utils/global-options.js';
import { log, print, printJson, style } from '../utils/output.js';

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
            suggestion: 'Check connectivity to api.kash.bot and retry.',
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
        suggestion: 'Check connectivity to api.kash.bot and retry.',
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
