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

import { USDC_DECIMAL_REGEX } from './utils/trade-input.js';

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
  /** Public-API version the profile pins (`YYYY-MM-DD`). */
  apiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sources: z.object({
    apiKey: z.enum(['env', 'file', 'unset']),
    baseUrl: z.enum(['env', 'file', 'default']),
    apiVersion: z.enum(['env', 'file', 'default']),
    profile: z.enum(['flag', 'env', 'file', 'default']),
  }),
});

export type CliConfigEnvelope = z.infer<typeof CliConfigEnvelopeSchema>;
