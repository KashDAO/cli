/**
 * Single source of truth for every error `code` the CLI emits.
 *
 * Both `toCliError` (the SDK-error mapper) and `kash explain <code>`
 * read from this catalog so an AI agent that hits a `RATE_LIMITED`
 * error and asks `kash explain RATE_LIMITED --json` gets the same
 * `recoverable`, `docsUrl`, and `actions` it would have seen on the
 * error envelope.
 *
 * Adding a new code: append an entry. Removing one: major bump.
 * Renaming a field: major bump.
 *
 * Runtime-only data (the server's `retryAfterMs`, the specific
 * `requestId`, an extra `wait_and_retry` action computed from the
 * Retry-After header) is layered on top by `toCliError` — the
 * catalog is for static metadata only.
 */

import type { CliErrorAction } from './errors.js';

export type ErrorCatalogEntry = {
  /** Stable machine-readable code. */
  readonly code: string;
  /** One-sentence summary in plain English. */
  readonly summary: string;
  /** Longer explanation suitable for human troubleshooting. */
  readonly description: string;
  /** Whether retrying the original request might succeed. */
  readonly recoverable: boolean;
  /** Stable docs URL, when one exists. */
  readonly docsUrl?: string;
  /**
   * Concrete recovery steps the agent can take. These are the
   * *static* actions for this code; runtime-only actions (e.g. a
   * `wait_and_retry` derived from the server's Retry-After header)
   * are appended by `toCliError`.
   */
  readonly actions: readonly CliErrorAction[];
};

export const ERROR_CATALOG: readonly ErrorCatalogEntry[] = [
  {
    code: 'AUTH_REQUIRED',
    summary: 'No API key was provided, or the key is invalid / expired / revoked.',
    description:
      'The Kash public API requires a kash_live_… or kash_test_… key on every authenticated route. First-time users should run `kash setup` (interactive wizard). Existing users can `kash auth set-key`, set KASH_API_KEY, or pass --profile to switch to a stored profile.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/authentication',
    actions: [
      {
        type: 'run_command',
        command: 'kash setup',
        description: 'First-run wizard — issues a key, configures profile, validates it.',
      },
      {
        type: 'run_command',
        command: 'kash auth set-key',
        description:
          'Store an API key for the active profile (paste interactively or pipe via stdin).',
      },
      {
        type: 'set_env',
        variable: 'KASH_API_KEY',
        description: 'Provide the key via environment variable.',
      },
      {
        type: 'open_url',
        url: 'https://kash.bot/settings/api-keys',
        description: 'Issue or rotate an API key from the Kash dashboard.',
      },
    ],
  },
  {
    code: 'INSUFFICIENT_SCOPE',
    summary: 'The API key is valid but lacks the scope this command requires.',
    description:
      "Authentication succeeded but the key's scope (read-only / trade / admin) doesn't cover the route. Issue a key with broader scope, or move to a tier that includes it.",
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/authentication',
    actions: [
      {
        type: 'open_url',
        url: 'https://kash.bot/settings/api-keys',
        description: 'Issue an API key with the required scope.',
      },
    ],
  },
  {
    code: 'RATE_LIMITED',
    summary: 'You have exceeded the per-key rate limit for this tier.',
    description:
      'Slow down or upgrade for higher limits. The error envelope carries `retryAfterMs`; honor it via `kash --max-retries` or back off in your application.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/api/rate-limits',
    actions: [
      {
        type: 'open_url',
        url: 'https://kash.bot/pricing',
        description: 'Upgrade tier for higher rate limits.',
      },
    ],
  },
  {
    code: 'NOT_FOUND',
    summary: 'The requested resource (market, trade, position) does not exist.',
    description:
      'Markets and trades are identified by UUID. Confirm the id is correct (especially after copy-paste truncation) and that the resource is visible to the active key.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/api/errors',
    actions: [],
  },
  {
    code: 'CONFLICT',
    summary: 'A conflicting request is already in flight or the resource state changed.',
    description:
      'Common cases: you sent a duplicate Idempotency-Key, the trade is awaiting high-value confirmation, or the market closed between fetch and trade. Inspect the resource before retrying.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/api/errors',
    actions: [
      {
        type: 'run_command',
        command: 'kash trade status <id>',
        description: 'Inspect the conflicting trade resource. Substitute <id> with the trade UUID.',
        template: true,
      },
    ],
  },
  {
    code: 'INVALID_INPUT',
    summary: 'The request body or arguments failed validation.',
    description:
      'Check the field names and types against `kash <command> --help` or `kash schema <command>`. USDC amounts are decimal strings with up to 6 fractional digits.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/commands',
    actions: [
      {
        type: 'run_command',
        command: 'kash <command> --help',
        description:
          'Inspect the command signature. Substitute <command> with the failing path (e.g. `trade buy`, `markets list`).',
        template: true,
      },
      {
        type: 'run_command',
        command: 'kash schema <command>',
        description:
          'Get the JSON Schema for the command inputs. Substitute <command> with the failing path.',
        template: true,
      },
    ],
  },
  {
    code: 'MAINTENANCE',
    summary: 'The Kash trade pipeline is temporarily disabled (kill switch).',
    description:
      'API trade processing is halted, typically during incident response or planned maintenance. Read state is unaffected. Honor the `retryAfterMs` and check the status page.',
    recoverable: true,
    docsUrl: 'https://status.kash.bot',
    actions: [
      {
        type: 'open_url',
        url: 'https://status.kash.bot',
        description: 'Check for ongoing incidents or planned windows.',
      },
    ],
  },
  {
    code: 'TIMEOUT',
    summary: 'The request exceeded the SDK timeout (default 30s).',
    description:
      'Either the server is slow or the network path is degraded. Retry, or pass --timeout-ms to raise the cap. Repeated timeouts are worth investigating against the status page.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/troubleshooting',
    actions: [
      {
        type: 'run_command',
        command: 'kash --timeout-ms 60000 <same command>',
        description:
          'Re-run with a longer timeout. Substitute <same command> with the original invocation tail.',
        template: true,
      },
    ],
  },
  {
    code: 'NETWORK',
    summary: 'A transport-layer failure (DNS, TLS, connection refused) before any HTTP response.',
    description:
      'The SDK never received a response. Check connectivity to api.kash.bot. The CLI retries network errors automatically; this means retries were exhausted.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/troubleshooting',
    actions: [],
  },
  {
    code: 'ABORTED',
    summary: 'The request was cancelled by the caller before it completed.',
    description:
      'An AbortSignal you passed (or the spinner you cancelled) fired while the request was in flight. The server may or may not have processed the request — if it did, the side effect already landed. Idempotent requests can be safely retried with the same Idempotency-Key.',
    recoverable: false,
    docsUrl: 'https://kash.bot/docs/cli/troubleshooting',
    actions: [],
  },
  {
    code: 'SERVER_ERROR',
    summary: 'The API returned a 5xx response after retries.',
    description:
      'The request is safe to retry. If the issue persists, check the status page and report with the requestId on the error envelope.',
    recoverable: true,
    docsUrl: 'https://status.kash.bot',
    actions: [
      {
        type: 'open_url',
        url: 'https://status.kash.bot',
        description: 'Check the public status page.',
      },
    ],
  },
  {
    code: 'CONFIGURATION',
    summary: 'The CLI configuration file or environment is invalid.',
    description:
      "The on-disk ~/.kash/config.json failed to parse, an env var (KASH_CHAIN_ID) doesn't match its expected shape, or a per-invocation flag (--max-retries, --timeout-ms, --base-url) was rejected by the SDK. Run `kash config show` to inspect what loaded.",
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/configuration',
    actions: [
      {
        type: 'run_command',
        command: 'kash config show',
        description: 'Inspect the loaded configuration and its sources.',
      },
    ],
  },
  // ─── Direct-mode (kash protocol ...) ─────────────────────────────
  {
    code: 'DIRECT_CONFIG_MISSING',
    summary: 'Direct-mode configuration is incomplete.',
    description:
      "Direct-mode commands (`kash protocol ...`) require RPC URL, smart account address, signer key reference, and chain ID. One or more of these is missing from the active profile and the environment. Run `kash config show` to see what's loaded; set the missing fields with `kash config set rpcUrl …`, `kash config set smartAccount 0x…`, etc.",
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/direct-mode',
    actions: [
      {
        type: 'run_command',
        command: 'kash config show',
        description: 'Inspect the loaded configuration and source attribution.',
      },
      {
        type: 'run_command',
        command: 'kash config set rpcUrl https://your-rpc.example.com',
        description: 'Set the RPC URL for direct-mode operations.',
      },
    ],
  },
  {
    code: 'SIGNER_FAILED',
    summary: 'The configured signer (file/env/KMS) failed to load or sign.',
    description:
      "The signer adapter referenced by `signerKeyRef` couldn't load the private key, or signing the UserOp hash failed. Common causes: missing/unreadable file, missing env var, malformed hex, or a KMS permission denial.",
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/direct-mode',
    actions: [
      {
        type: 'check_input',
        field: 'signerKeyRef',
        description: 'Verify the signer reference (file:<path> or env:<VAR>) and its target.',
      },
    ],
  },
  {
    code: 'RPC_FAILED',
    summary: 'The RPC endpoint refused the request or timed out.',
    description:
      'Network call to the configured `rpcUrl` failed. Could be a rate-limit at the RPC provider, a transient network issue, or a misconfigured URL. The protocol-sdk does NOT retry RPC calls — fail fast so the operator sees the issue.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/troubleshooting',
    actions: [
      {
        type: 'check_input',
        field: 'rpcUrl',
        description: 'Verify the RPC URL is reachable and the API key (if any) is valid.',
      },
    ],
  },
  {
    code: 'BUNDLER_REJECTED',
    summary: 'The bundler refused to relay the UserOp.',
    description:
      'Common rejection reasons: replacement-underpriced, sender-mempool-full, gas estimation drift, or a UserOp that the bundler suspects will revert. The error message carries the bundler-specific reason verbatim.',
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/direct-mode',
    actions: [],
  },
  {
    code: 'TRANSACTION_REVERTED',
    summary: 'The UserOp executed but the on-chain call reverted.',
    description:
      'The transaction landed on-chain but the contract call reverted. The error message carries the decoded revert reason when the protocol-sdk recognises it (e.g. `MarketFrozen`, `InsufficientReserve`). Re-running with `kash protocol simulate` first will catch most reverts before they cost gas.',
    recoverable: false,
    docsUrl: 'https://kash.bot/docs/cli/direct-mode',
    actions: [
      {
        type: 'run_command',
        command:
          'kash protocol simulate <market-address> --action <buy|sell> --outcome <i> --amount <n>',
        description:
          'Dry-run the trade against current chain state before re-submitting. Substitute every <placeholder>.',
        template: true,
      },
    ],
  },
  {
    code: 'CHAIN_ERROR',
    summary: 'A protocol-level chain interaction failed.',
    description:
      "An on-chain read or simulation returned an unexpected shape, decoded to an unknown revert, or the contract addresses don't match the configured chain ID. Verify the chain ID and that the protocol contracts are deployed at the expected addresses for that chain.",
    recoverable: false,
    docsUrl: 'https://kash.bot/docs/cli/direct-mode',
    actions: [
      {
        type: 'check_input',
        field: 'chainId',
        description: 'Confirm chainId matches the network your RPC and bundler target.',
      },
    ],
  },
  {
    code: 'UNEXPECTED',
    summary: 'An unrecognised error escaped the SDK or the CLI.',
    description:
      "This means the CLI's error mapper didn't recognise the underlying failure — the most likely cause is an SDK or runtime issue. File an issue with the message, the command, and the runtime info from `kash version --json`.",
    recoverable: false,
    docsUrl: 'https://github.com/KashDAO/cli/issues',
    actions: [
      {
        type: 'run_command',
        command: 'kash version --json',
        description: 'Capture runtime info to attach to the bug report.',
      },
    ],
  },
  {
    code: 'NOOP',
    summary: 'No-op exit (Commander emitted output and asked us to stop).',
    description:
      "Commander's help/version paths don't represent a failure — it printed `--help` or `--version` output and signalled the CLI to exit cleanly. This code surfaces in JSON-output contexts so consumers know the run completed without doing real work; the human path exits 0 with no error envelope.",
    recoverable: true,
    docsUrl: 'https://kash.bot/docs/cli/exit-codes',
    actions: [],
  },
];

const CATALOG_BY_CODE = new Map<string, ErrorCatalogEntry>(
  ERROR_CATALOG.map((entry) => [entry.code, entry])
);

export function lookupErrorCode(code: string): ErrorCatalogEntry | undefined {
  return CATALOG_BY_CODE.get(code);
}

/**
 * Resolve the catalog entry for a code, falling back to the
 * `UNEXPECTED` entry when the code isn't recognised.
 *
 * The fallback exists so opaque SDK codes (e.g. a new `KashError`
 * subclass that hasn't been mapped CLI-side yet) still produce a
 * usable `kash explain <code>` response — the agent learns "we don't
 * recognise this code, file an issue" instead of "Unknown error
 * code", which would be a dead end.
 */
export function lookupErrorCodeWithFallback(code: string): ErrorCatalogEntry {
  const entry = CATALOG_BY_CODE.get(code);
  if (entry) return entry;
  // The UNEXPECTED entry is always present; safe to assert.
  return CATALOG_BY_CODE.get('UNEXPECTED')!;
}

/** Set of every catalog code, exposed for invariant tests. */
export const ERROR_CODES: ReadonlySet<string> = new Set(ERROR_CATALOG.map((e) => e.code));
