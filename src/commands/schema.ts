/**
 * `kash schema [<resource>]` — emit JSON Schema for the SDK's
 * request/response shapes.
 *
 * AI agents call this to understand the wire format without scraping
 * the OpenAPI spec or reading TypeScript types. The schemas come
 * straight from `@kashdao/sdk`'s Zod exports — so they always match
 * what the CLI actually sends and receives.
 *
 * Agents typically want one of two things:
 *
 *   1. `kash schema` — full catalog so they can index every shape
 *      up front (returns `{ <name>: <jsonSchema>, … }`).
 *   2. `kash schema <name>` — one schema, e.g. `CreateTradeBody`,
 *      to validate a request body locally before submitting.
 */

import {
  ConfirmTradeBodySchema,
  ConfirmTradeResponseSchema,
  CreateTradeAcceptedResponseSchema,
  CreateTradeBodySchema,
  GetMarketResponseSchema,
  GetTraceResponseSchema,
  GetTradeResponseSchema,
  ListMarketsResponseSchema,
  ListTradesResponseSchema,
  ListWebhookEventsResponseSchema,
  MarketResourceSchema,
  PaginationSchema,
  PortfolioSummarySchema,
  PositionResourceSchema,
  PositionsResponseSchema,
  ProblemDetailsSchema,
  QuoteBuyDetailSchema,
  QuoteMarketSummarySchema,
  QuoteResponseSchema,
  QuoteSellDetailSchema,
  RedeliverWebhookEventSchema,
  RedeliverWebhookResponseSchema,
  RotateWebhookSecretResponseSchema,
  TraceEventDataSchema,
  TraceEventSchema,
  TraceResourceSchema,
  TradeResourceSchema,
  WebhookEventResourceSchema,
} from '@kashdao/sdk';
import { Command } from 'commander';

import {
  CliConfigEnvelopeSchema,
  CliErrorActionSchema,
  CliErrorEnvelopeSchema,
  HealthResultSchema,
  ProtocolBalanceEnvelopeSchema,
  ProtocolMarketEnvelopeSchema,
  ProtocolQuoteEnvelopeSchema,
  TradeDryRunEnvelopeSchema,
  VersionManifestSchema,
} from '../cli-schemas.js';
import { CliError } from '../errors.js';
import { readGlobals } from '../utils/global-options.js';
import { print, printJson, style } from '../utils/output.js';

import type { ZodTypeAny } from 'zod';
import type { zodToJsonSchema as ZodToJsonSchemaFn } from 'zod-to-json-schema';

/**
 * Stable name → Zod schema map. Adding entries is a minor bump;
 * removing/renaming is a major bump.
 *
 * Names are PascalCase to match the TypeScript types consumers see in
 * `@kashdao/sdk` — keeps documentation, code, and CLI output in sync.
 *
 * Two groups:
 *   - **CLI-owned contracts** (`Cli*`, `VersionManifest`) — the
 *     shapes the CLI itself emits. Pinning to these is the
 *     recommended path for agents that consume `kash <cmd> --json`.
 *   - **SDK request/response shapes** — the wire formats the CLI
 *     forwards. Mirror what the public API produces.
 */
const SCHEMA_MAP: Record<string, ZodTypeAny> = {
  // CLI-owned contracts
  CliErrorEnvelope: CliErrorEnvelopeSchema,
  CliErrorAction: CliErrorActionSchema,
  CliConfigEnvelope: CliConfigEnvelopeSchema,
  VersionManifest: VersionManifestSchema,
  HealthResult: HealthResultSchema,
  // Direct-mode CLI-owned envelopes
  ProtocolBalanceEnvelope: ProtocolBalanceEnvelopeSchema,
  ProtocolMarketEnvelope: ProtocolMarketEnvelopeSchema,
  ProtocolQuoteEnvelope: ProtocolQuoteEnvelopeSchema,
  // Common (wire-format)
  Pagination: PaginationSchema,
  ProblemDetails: ProblemDetailsSchema,
  // Markets
  MarketResource: MarketResourceSchema,
  GetMarketResponse: GetMarketResponseSchema,
  ListMarketsResponse: ListMarketsResponseSchema,
  // Quotes
  QuoteResponse: QuoteResponseSchema,
  QuoteBuyDetail: QuoteBuyDetailSchema,
  QuoteSellDetail: QuoteSellDetailSchema,
  QuoteMarketSummary: QuoteMarketSummarySchema,
  // Trades — request bodies
  CreateTradeBody: CreateTradeBodySchema,
  ConfirmTradeBody: ConfirmTradeBodySchema,
  // Trades — dry-run envelope (CLI-owned)
  TradeDryRunEnvelope: TradeDryRunEnvelopeSchema,
  // Trades — responses
  TradeResource: TradeResourceSchema,
  CreateTradeAcceptedResponse: CreateTradeAcceptedResponseSchema,
  ConfirmTradeResponse: ConfirmTradeResponseSchema,
  GetTradeResponse: GetTradeResponseSchema,
  ListTradesResponse: ListTradesResponseSchema,
  // Portfolio
  PortfolioSummary: PortfolioSummarySchema,
  PositionResource: PositionResourceSchema,
  PositionsResponse: PositionsResponseSchema,
  // Webhooks
  WebhookEventResource: WebhookEventResourceSchema,
  ListWebhookEventsResponse: ListWebhookEventsResponseSchema,
  RedeliverWebhookEvent: RedeliverWebhookEventSchema,
  RedeliverWebhookResponse: RedeliverWebhookResponseSchema,
  RotateWebhookSecretResponse: RotateWebhookSecretResponseSchema,
  // Traces (correlation timeline)
  TraceEventData: TraceEventDataSchema,
  TraceEvent: TraceEventSchema,
  TraceResource: TraceResourceSchema,
  GetTraceResponse: GetTraceResponseSchema,
};

const SCHEMA_NAMES = Object.keys(SCHEMA_MAP).sort();

/**
 * Wrap `zodToJsonSchema` once at the boundary. Its generic argument
 * is `ZodType<any, ZodTypeDef, any>` — narrower than the
 * `ZodTypeAny` we use to type `SCHEMA_MAP`. Confining the
 * eslint-disable here keeps the rest of the file lint-clean.
 *
 * Calling `zodToJsonSchema(schema)` without `{ name }` produces the
 * unwrapped schema directly. The wrapped form (`{ $ref, definitions }`)
 * would be surprising for agents that expect the schema at the top
 * level. We commit to the unwrapped shape as the SemVer-stable
 * contract.
 *
 * **Lazy-loaded.** `zod-to-json-schema` adds ~10ms to startup; the
 * `kash schema` command is a niche introspection path, so we defer
 * the import to the first call. Cached after the first action so
 * iterating over `SCHEMA_MAP` doesn't re-import per entry.
 */
let zodToJsonSchemaImpl: typeof ZodToJsonSchemaFn | undefined;

async function loadZodToJsonSchema(): Promise<typeof ZodToJsonSchemaFn> {
  if (zodToJsonSchemaImpl !== undefined) return zodToJsonSchemaImpl;
  const mod = await import('zod-to-json-schema');
  zodToJsonSchemaImpl = mod.zodToJsonSchema;
  return zodToJsonSchemaImpl;
}

function toJsonSchema(
  impl: typeof ZodToJsonSchemaFn,
  schema: ZodTypeAny
): ReturnType<typeof ZodToJsonSchemaFn> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return impl(schema);
}

type SchemaOptions = {
  list?: boolean;
};

export const schemaCommand = new Command('schema')
  .description('Emit JSON Schema for the SDK request/response shapes.')
  .argument(
    '[name]',
    `optional schema name; omit to list every available schema (one of: ${SCHEMA_NAMES.join(', ')})`
  )
  .option(
    '--list',
    'emit only the schema names (cheap probe: skips the zod-to-json-schema conversion that the full --json catalog needs)'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash schema                            # list available schema names (human)
  $ kash schema --list --json --quiet      # cheap agent probe: just the names
  $ kash schema CreateTradeBody --json     # JSON Schema for the trade request
  $ kash schema TradeResource --json       # JSON Schema for the trade response

Notes:
  Bare \`kash schema --json\` converts every Zod schema (~36 entries)
  to JSON Schema — that's ~tens-of-KB and ~360ms of CPU. AI agents
  doing capability probes should use \`kash schema --list --json\`
  to fetch just the catalog of names, then drill into the specific
  schema they actually need.
`
  )
  .action(async (name: string | undefined, options: SchemaOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    // --list short-circuits before zod-to-json-schema loads. Cheapest
    // path for agent probes: returns a flat name array.
    if (options.list === true) {
      if (globals.json) {
        printJson({ schemas: SCHEMA_NAMES });
        return;
      }
      print('');
      print(style.bold('Available schemas:'));
      for (const n of SCHEMA_NAMES) {
        print(`  - ${n}`);
      }
      print('');
      return;
    }

    // Listing names without --json doesn't need the converter at all —
    // skip the heavy import for the catalog-listing case.
    if (name === undefined && !globals.json) {
      print('');
      print(style.bold('Available schemas:'));
      for (const n of SCHEMA_NAMES) {
        print(`  - ${n}`);
      }
      print('');
      print(style.dim('Run `kash schema <name> --json` for the full JSON Schema.'));
      return;
    }

    const impl = await loadZodToJsonSchema();

    if (name === undefined) {
      // --json catalog: emit each schema inline (unwrapped — see comment
      // on the per-schema branch).
      const catalog: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(SCHEMA_MAP)) {
        catalog[key] = toJsonSchema(impl, schema);
      }
      printJson({ schemas: catalog });
      return;
    }

    const schema = SCHEMA_MAP[name];
    if (!schema) {
      throw new CliError(`Unknown schema: ${name}`, {
        code: 'INVALID_INPUT',
        recoverable: true,
        suggestion: `Run \`kash schema\` (no argument) to list every available schema name.`,
      });
    }

    const json = toJsonSchema(impl, schema);
    if (globals.json) {
      printJson(json);
      return;
    }
    print(JSON.stringify(json, null, 2));
  });
