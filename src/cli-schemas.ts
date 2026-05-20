/**
 * CLI-owned Zod schemas — the SemVer-stable contracts the CLI itself
 * defines (rather than the wire formats the SDK defines).
 *
 * Currently:
 *   - `CliErrorEnvelopeSchema` — the JSON shape every command emits
 *     on failure when `--json` is set. Agents pin to this contract
 *     to recover from errors deterministically.
 *   - `CliErrorActionSchema` — discriminated union of recovery hints.
 *   - `VersionManifestSchema` — what `kash version --json` returns.
 *   - `CliConfigEnvelopeSchema` — what `kash config show --json` returns.
 *
 * These are exported via `kash schema --json` so an AI agent can
 * validate output against the schema before parsing.
 */

import { z } from 'zod';

import { BIGINT_STRING_REGEX, HEX_ADDRESS_REGEX, USDC_DECIMAL_REGEX } from './utils/trade-input.js';

const cliErrorActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_command'),
    command: z.string(),
    description: z.string(),
    /**
     * `true` when `command` contains `<placeholder>` tokens the
     * caller must substitute. Absent / `false` means concrete and
     * safe to auto-execute. Agents that auto-shell `run_command`
     * actions MUST honour this flag — otherwise the literal
     * "<id>" / "<command>" reaches the shell and fails.
     */
    template: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('set_env'),
    variable: z.string(),
    description: z.string(),
  }),
  z.object({
    type: z.literal('wait_and_retry'),
    delayMs: z.number().int().nonnegative(),
    description: z.string(),
  }),
  z.object({
    type: z.literal('open_url'),
    url: z.string().url(),
    description: z.string(),
  }),
  z.object({
    type: z.literal('check_input'),
    field: z.string(),
    description: z.string(),
  }),
]);

export const CliErrorActionSchema = cliErrorActionSchema;

/**
 * The error envelope `kash <cmd> --json` emits on any failure path.
 *
 * Required: `code`, `message`, `recoverable`, `actions`. The optional
 * fields (`suggestion`, `retryAfterMs`, `docsUrl`, `requestId`) appear
 * only when the underlying error provides them — agents pinning to
 * the schema must treat them as optional.
 */
export const CliErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
    suggestion: z.string().optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    docsUrl: z.string().url().optional(),
    requestId: z.string().optional(),
    actions: z.array(cliErrorActionSchema),
  }),
});

export type CliErrorEnvelope = z.infer<typeof CliErrorEnvelopeSchema>;

/**
 * Stable feature flags an AI-agent or downstream tool can pin against.
 * Each capability is a string token: presence means "this CLI release
 * supports the feature." Removing a token is a SemVer-breaking event;
 * adding one is additive (consumers must do containment checks, not
 * equality).
 *
 * Maintained in `version.ts`'s manifest builder so a single grep
 * shows what every release advertises.
 */
export const CliCapabilitySchema = z.enum([
  // Output / agent surface
  'json-envelope', // every command emits a stable `--json` shape
  'json-quiet', // `--json --quiet` for compact NDJSON-style stdout
  'fields-projection', // `--fields a,b,c` projection on JSON output
  'filter-dsl', // `--filter` boolean DSL on JSON output
  'ndjson-streaming', // `--ndjson` flag on list / streaming commands
  // Error surface
  'kash-explain', // `kash explain CODE` recovery catalog
  'structured-actions', // typed `actions[]` on every error envelope
  // Trade modes
  'trade-place', // public-API hosted-trade flow (`kash trade buy/sell`)
  'protocol-trade', // SA-mode direct UserOp execution
  'eoa-trade', // EOA-mode vanilla EIP-1559 trade execution
  'protocol-userop', // offline UserOp sign/submit lifecycle
  'protocol-watch', // NDJSON event subscription
  'partial-completion-records', // `{partial: true}` records on submit-then-wait failure
  // Webhooks
  'webhooks-replay', // `kash webhooks replay` with HMAC re-signing
  'webhooks-replay-dry-run', // `--dry-run` for inspect-without-send
  'webhooks-replay-refuse-private', // `--refuse-private-addresses` hard-fail
  // Discovery
  'mcp-server', // `kash mcp serve` (Model Context Protocol)
]);
export type CliCapability = z.infer<typeof CliCapabilitySchema>;

/** Shape of `kash version --json`. */
export const VersionManifestSchema = z.object({
  cli: z.string(),
  sdk: z.string(),
  node: z.string(),
  platform: z.string(),
  release: z.string(),
  arch: z.string(),
  /**
   * Feature-detection tokens — listed iff this release implements the
   * named capability. Additive across releases; removing a token is
   * a breaking change.
   */
  capabilities: z.array(CliCapabilitySchema).optional(),
});

export type VersionManifest = z.infer<typeof VersionManifestSchema>;

/**
 * Shape of `kash health --json`. Mirrors the SDK's
 * `KashClient.healthCheck` result: `ok` is the load-bearing field;
 * everything else is best-effort metadata.
 */
export const HealthResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  status: z.string().optional(),
  version: z.string().optional(),
  requestId: z.string().optional(),
});

export type HealthResult = z.infer<typeof HealthResultSchema>;

// ── Direct-mode (`kash protocol …`) envelopes ─────────────────────

/** Shape of `kash protocol balance --json`. */
export const ProtocolBalanceEnvelopeSchema = z.object({
  account: z.string().regex(HEX_ADDRESS_REGEX),
  chainId: z.number().int().positive(),
  /** USDC balance in atomic units (6 decimals). Stringified bigint. */
  usdcAtomic: z.string().regex(BIGINT_STRING_REGEX),
  /** Native ETH balance in wei. Stringified bigint. */
  gasWei: z.string().regex(BIGINT_STRING_REGEX),
});
export type ProtocolBalanceEnvelope = z.infer<typeof ProtocolBalanceEnvelopeSchema>;

/** Shape of `kash protocol market --json`. */
export const ProtocolMarketEnvelopeSchema = z.object({
  marketAddress: z.string().regex(HEX_ADDRESS_REGEX),
  chainId: z.number().int().positive(),
  status: z.enum(['unseeded', 'active', 'frozen', 'resolved']),
  /** block.timestamp at read time (seconds), stringified bigint. */
  readAt: z.string().regex(BIGINT_STRING_REGEX),
  /** Reserve in WAD-18, stringified bigint. */
  reserveWad: z.string().regex(BIGINT_STRING_REGEX),
  outcomes: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      outstandingTokensWad: z.string().regex(BIGINT_STRING_REGEX),
      weightWad: z.string().regex(BIGINT_STRING_REGEX),
      probability: z.number().min(0).max(1),
    })
  ),
});
export type ProtocolMarketEnvelope = z.infer<typeof ProtocolMarketEnvelopeSchema>;

/** Shape of `kash protocol quote --json`. */
export const ProtocolQuoteEnvelopeSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  outcomeIndex: z.number().int().nonnegative(),
  /** Atomic units: USDC (6dp) on BUY, outcome tokens (18dp) on SELL. */
  amountIn: z.string().regex(BIGINT_STRING_REGEX),
  /** Atomic units: outcome tokens (18dp) on BUY, USDC (6dp) on SELL. */
  amountOut: z.string().regex(BIGINT_STRING_REGEX),
  reserveAfterWad: z.string().regex(BIGINT_STRING_REGEX),
  pricesAfterWad: z.array(z.string().regex(BIGINT_STRING_REGEX)),
});
export type ProtocolQuoteEnvelope = z.infer<typeof ProtocolQuoteEnvelopeSchema>;

// ── Dry-run envelopes ─────────────────────────────────────────────

/**
 * Shape of `kash trade buy --dry-run --json` and
 * `kash trade sell --dry-run --json`. Agents use this to plan a trade
 * locally without hitting the API: the envelope describes exactly what
 * the CLI WOULD send if the same invocation ran without `--dry-run`.
 *
 * `wouldSend` is the request body. `idempotencyKey` echoes the resolved
 * `Idempotency-Key` header (auto-generated UUID v4 when
 * `--auto-idempotency-key` is set; null otherwise). `endpoint` pins the
 * HTTP method + path so consumers can reproduce the call out-of-band.
 */
export const TradeDryRunEnvelopeSchema = z.object({
  wouldSend: z.object({
    marketId: z.string().uuid(),
    outcomeIndex: z.number().int().nonnegative(),
    amount: z.string().regex(USDC_DECIMAL_REGEX),
    side: z.enum(['buy', 'sell']),
    clientRequestId: z.string().optional(),
  }),
  idempotencyKey: z.string().nullable(),
  endpoint: z.object({
    method: z.literal('POST'),
    path: z.literal('/v1/trades'),
  }),
});
export type TradeDryRunEnvelope = z.infer<typeof TradeDryRunEnvelopeSchema>;

/**
 * Shape of `kash config show --json` and (mostly) of
 * `kash auth status --json`. Agents pin to this contract; the two
 * commands deliberately emit the same shape so consumers don't have
 * to keep two schemas in mind.
 */
export const CliConfigEnvelopeSchema = z.object({
  profile: z.string(),
  authenticated: z.boolean(),
  apiKey: z.string().nullable(),
  baseUrl: z.string().url(),
  defaultChainId: z.number().int().positive(),
  // Direct-mode fields. Always present (`null` when unset) so the
  // shape is uniform across pure-custodial and direct-mode profiles
  // — agents pinning to this schema can read every field without
  // optionality branches. The `signerKeyRef` is a reference shape
  // (`file:<path>` / `env:<NAME>`); the raw private key is never
  // emitted (the CLI never persists keys, even redacted).
  rpcUrl: z.string().url().nullable(),
  smartAccount: z.string().regex(HEX_ADDRESS_REGEX).nullable(),
  bundlerUrl: z.string().url().nullable(),
  bundlerProvider: z.enum(['flashbots', 'pimlico', 'alchemy', 'generic']).nullable(),
  signerKeyRef: z.string().nullable(),
  /**
   * Custom-chain block — `null` when the profile uses the static
   * registry (the typical Base mainnet / Sepolia case). Required for
   * any chain the registry doesn't cover (Anvil / forks / sidechains).
   * `smartAccount` (the inner factory + EntryPoint addresses) is only
   * required when running SA mode on the custom chain — EOA mode
   * ignores it.
   */
  customChain: z
    .object({
      // All fields are optional in the persisted schema (so `kash
      // config set customChain.<leaf>` writes one leaf at a time);
      // completeness is enforced at use time in `resolveCliCustomChain`.
      // The JSON envelope mirrors that: half-built customChain blocks
      // are emitted faithfully so `kash config show --json` matches
      // what's on disk.
      name: z.string().min(1).optional(),
      factoryAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
      usdcAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
      oracleAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
      vaultAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
      tokens1155Address: z.string().regex(HEX_ADDRESS_REGEX).optional(),
      paramRegistryAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
      smartAccount: z
        .object({
          factoryAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
          implementationAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
          entryPointAddress: z.string().regex(HEX_ADDRESS_REGEX).optional(),
        })
        .optional(),
    })
    .nullable(),
  sources: z.object({
    apiKey: z.enum(['env', 'file', 'unset']),
    baseUrl: z.enum(['env', 'file', 'default']),
    defaultChainId: z.enum(['env', 'file', 'default']),
    profile: z.enum(['flag', 'env', 'file', 'default']),
    rpcUrl: z.enum(['env', 'file', 'unset']),
    smartAccount: z.enum(['env', 'file', 'unset']),
    bundlerUrl: z.enum(['env', 'file', 'unset']),
    bundlerProvider: z.enum(['env', 'file', 'unset']),
    signerKeyRef: z.enum(['env', 'file', 'unset']),
    customChain: z.enum(['file', 'unset']),
  }),
});

export type CliConfigEnvelope = z.infer<typeof CliConfigEnvelopeSchema>;
