# `@kashdao/cli`

Official command-line interface for the [Kash](https://kash.bot) prediction-market protocol.

[![npm version](https://img.shields.io/npm/v/@kashdao/cli.svg)](https://www.npmjs.com/package/@kashdao/cli)
[![types](https://img.shields.io/npm/types/@kashdao/cli.svg)](https://www.npmjs.com/package/@kashdao/cli)
[![license](https://img.shields.io/npm/l/@kashdao/cli.svg)](./LICENSE)
[![Node 22+](https://img.shields.io/node/v/@kashdao/cli.svg)](https://nodejs.org)
[![Homebrew](https://img.shields.io/badge/homebrew-kashdao%2Ftap%2Fkash-orange)](https://github.com/KashDAO/homebrew-tap)

Wraps [`@kashdao/sdk`](https://www.npmjs.com/package/@kashdao/sdk): API-key
auth against the public REST API. **Non-custodial** — Kash is an interface to a
decentralized, permissionless protocol on Solana, users own their wallets and
assets, and Kash never holds custody of user funds. The API key is a scoped,
revocable permission you grant; Kash submits the transactions you request
through it, and you can revoke it at any time. See
[SECURITY.md § Non-custodial design](./SECURITY.md#non-custodial-design)
for the full statement.

```sh
npm install -g @kashdao/cli
kash auth set-key kash_live_…
kash markets list --status ACTIVE
kash trade buy <market-id> --outcome 0 --amount 10 --wait
```

- **Two audiences, equally first-class.** Humans get colored tables, spinners,
  and tab completion; AI agents get `--json --quiet`, structured errors with
  machine-readable recovery actions, and full command-tree introspection via
  `kash docs --json`.
- **Stable JSON contracts.** Every shape an agent or script consumes is
  pinned to a Zod schema and exposed via `kash schema --json`.
- **Multi-profile.** AWS-CLI-style profile system for juggling
  test/staging/prod keys.
- **Zero-runtime config.** Drop in a `kash_*` API key and go — no OAuth,
  no SSO, no browser flow.

---

## Contents

- [Install](#install) · [Quickstart](#quickstart) · [Authentication](#authentication)
- [Commands](#commands) · [Multi-profile workflow](#multi-profile-workflow)
- [AI-agent / scripting mode](#ai-agent-scripting-mode) · [Webhook signing](#webhook-signing)
- [Configuration reference](#configuration-reference) · [Operational flags](#operational-flags)
- [Stability promise](#stability-promise) · [Troubleshooting](#troubleshooting)
- [Examples](#examples) · [Development](#development) · [License](#license)

---

> 🚀 **Live on mainnet.** The production API (`api.kash.bot`) is live.
> Create an API key under **Settings → API Keys** in the
> [Kash app](https://app.kash.bot): a `kash_live_*` key auto-routes to
> production (Solana mainnet), a `kash_test_*` key auto-routes to staging
> (`api-staging.kash.bot`, Solana devnet) for dry-runs.
>
> **Every Kash market trades on Solana.** `kash markets get` shows each
> market's chain (`solana:mainnet-beta` in production, `solana:devnet` on
> staging).

## Install

Pick whichever installer fits your environment:

```sh
# 1. One-line installer (POSIX shell — checks Node version,
#    picks pnpm/yarn/npm automatically, idempotent on re-run).
curl -fsSL https://raw.githubusercontent.com/KashDAO/cli/main/scripts/install.sh | sh

# 2. npm / pnpm / yarn directly:
npm install -g @kashdao/cli
pnpm add -g @kashdao/cli
yarn global add @kashdao/cli

# 3. Zero-install (one-shot via npx — useful for CI smoke checks):
npx -y @kashdao/cli@latest --version
npx -y @kashdao/cli@latest markets list --json
```

A `kashdao/tap` Homebrew tap is planned. Until it lands, use one of the installers above.

The package installs a `kash` binary.

**Requirements:** Node.js 22 or newer. Works on macOS, Linux, and Windows
(WSL recommended). Chmod-based permission tightening is best-effort and skipped
on Windows.

The one-line installer accepts `--version <semver>`, `--pm <pnpm|yarn|npm>`,
and `--dry-run` if you want to inspect the resolved command before running it.

## Quickstart

```sh
# 1. Configure an API key (create one under Settings → API Keys at https://app.kash.bot)
kash auth set-key kash_live_…

# 2. Browse markets
kash markets list --status ACTIVE

# 3. Place a trade and wait for settlement
kash trade buy <market-id> --outcome 0 --amount 10 --wait

# 4. Inspect your portfolio
kash portfolio show
kash portfolio positions

# 5. Once a market resolves, redeem the winning outcome
kash redeem <market-id> --outcome 0
```

## Authentication

Create an API key under **Settings → API Keys** in the
[Kash app](https://app.kash.bot) — `kash_live_*` for Solana mainnet or
`kash_test_*` for Solana devnet — then store it locally with one of:

```sh
# Persisted in ~/.kash/config.json (mode 0600)
kash auth set-key kash_test_…

# Per-shell, no on-disk persistence
export KASH_API_KEY=kash_test_…

# Per-invocation, no persistence
KASH_API_KEY=kash_live_… kash markets list
```

Inspect the resolved auth state with `kash auth status` (offline; does not call
the API). When you need a fresh shell or to log out:

```sh
kash auth logout            # clears apiKey from the active profile
kash config reset --yes     # nuclear: deletes ~/.kash/config.json entirely
```

Every authenticated `kash` command requires an API key. The CLI fails
fast with a clear `AUTH_REQUIRED` message if no key is configured
(`kash config show` to check). Per-key rate limits and audit
attribution apply on every request.

---

## Commands

| Group        | Subcommands                                                             |
| ------------ | ----------------------------------------------------------------------- |
| `auth`       | `set-key`, `status`, `logout`                                           |
| `markets`    | `list`, `get`, `predictions`                                            |
| `quote`      | `buy`, `sell` — AMM price quotes (`markets:quote` scope)                |
| `trade`      | `buy`, `sell`, `status`, `list`, `confirm`                              |
| `redeem`     | `<marketId> --outcome <i>` — redeem a settled position                  |
| `portfolio`  | `show`, `positions`                                                     |
| `webhooks`   | `list`, `rotate-secret`, `redeliver`, `verify`, `replay`                |
| `config`     | `show`, `set`, `profiles`, `use`, `remove`, `reset`, `export`, `import` |
| `health`     | (top-level; honors `--timeout-ms`, exits 1 when down)                   |
| `version`    | (top-level; also accepts `--json`)                                      |
| `explain`    | `[codes...]` — error code lookup (multi-code allowed)                   |
| `schema`     | `[name]` — JSON Schema for SDK + CLI envelopes                          |
| `setup`      | first-run interactive wizard (auth + verify + completion)               |
| `trace`      | `<correlationId>` — curated event timeline for a trade                  |
| `with-retry` | `-- <command> [args...]` — retry on recoverable failures                |
| `docs`       | full command tree (use `--json` for the agent surface)                  |
| `completion` | `install`, `uninstall`                                                  |

Run `kash <command> --help` for full option reference. Every command's `--help`
includes worked examples for both human and `--json --quiet` invocations.

## Multi-profile workflow

The CLI supports AWS-CLI-style profiles for juggling multiple keys:

```sh
# Issue keys against multiple environments
kash --profile prod    auth set-key kash_live_…
kash --profile staging auth set-key kash_test_…
kash --profile ci      auth set-key kash_live_…

# Switch the active profile (writes currentProfile to ~/.kash/config.json)
kash config use staging

# List configured profiles
kash config profiles
# {
#   "current": "staging",
#   "profiles": ["ci", "prod", "staging"]
# }

# Override the active profile per-invocation
kash --profile prod markets list

# Override via environment for a sub-shell
KASH_PROFILE=ci kash trade list

# Remove a profile (refuses to remove the active one)
kash config remove staging
```

The on-disk file at `~/.kash/config.json` looks like:

```json
{
  "version": 1,
  "currentProfile": "staging",
  "profiles": {
    "prod": { "apiKey": "kash_live_…" },
    "staging": { "apiKey": "kash_test_…", "baseUrl": "https://api-staging.kash.bot/v1" },
    "ci": { "apiKey": "kash_live_…" }
  }
}
```

Resolution order: explicit `--profile <name>` flag → `KASH_PROFILE` env →
`currentProfile` in the file → `default`.

---

## AI-agent / scripting mode

Every command supports `--json` and `--quiet` for machine consumption:

```sh
# JSON mode, suppress spinners/info — ideal for AI agents and CI.
kash markets list --status ACTIVE --json --quiet | jq '.data[0].id'

# Place a trade, block on settlement, parse the resulting tx hash.
kash trade buy <id> --outcome 0 --amount 5 --wait --json --quiet | jq -r .txHash

# Stream paginated reads as NDJSON (one record per line).
kash markets list --ndjson | while read -r line; do echo "$line" | jq -r .id; done
```

### Agent discovery surface

Three commands expose the CLI's shape in machine-readable form so an
AI agent can plan calls without scraping help text:

| Command                        | What it returns                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kash docs --json`             | Full command tree (every command, argument, option, alias, default value).                                                                       |
| `kash schema [<name>] --json`  | JSON Schema for SDK request/response shapes + CLI-owned envelopes (`CreateTradeBody`, `TradeResource`, `MarketResource`, `CliErrorEnvelope`, …). |
| `kash explain [<code>] --json` | Error catalog with `recoverable`, `retryAfterMs`, `docsUrl`, and structured recovery `actions[]`.                                                |

For first-time agent setup, dump everything into one document:

```sh
kash version --json   > kash-surface.json   # cli/sdk/node/platform versions
kash docs    --json  >> kash-surface.json   # full command tree
kash schema  --json  >> kash-surface.json   # every JSON Schema
kash explain --json  >> kash-surface.json   # every error code + recovery actions
```

See [`examples/agent-discovery.py`](./examples/agent-discovery.py) for a runnable
recipe that loads this into an agent's startup context.

### Error envelope contract

Every command emits this shape on `--json` failures. The shape is
SemVer-stable; pin to it.

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded",
    "recoverable": true,
    "retryAfterMs": 30000,
    "docsUrl": "https://kash.bot/docs/api/rate-limits",
    "requestId": "req_abc",
    "suggestion": "Retry in 30s. Upgrade for higher limits: https://kash.bot/pricing",
    "actions": [
      {
        "type": "wait_and_retry",
        "delayMs": 30000,
        "description": "Wait 30s then re-run the same command."
      },
      {
        "type": "open_url",
        "url": "https://kash.bot/pricing",
        "description": "Upgrade tier for higher rate limits."
      }
    ]
  }
}
```

**Required:** `code`, `message`, `recoverable`, `actions`. **Optional:**
`retryAfterMs`, `docsUrl`, `requestId`, `suggestion`. Action variants:
`run_command`, `set_env`, `wait_and_retry`, `open_url`, `check_input`.

Fetch the formal Zod-derived JSON Schema with:

```sh
kash schema CliErrorEnvelope --json
```

### Exit codes

- `0` — success
- `1` — generic error (validation, server, network, etc.)
- `2` — auth failure (missing or invalid API key, missing scope)

### Idempotent retries

For trade-creation calls (`kash trade buy/sell`), pass either an explicit
`--idempotency-key <uuid>` or `--auto-idempotency-key` to let the CLI generate
one. The resolved key is surfaced in the response, so a transient failure
mid-creation can be retried with the same key — the server guarantees the
trade is created at most once.

```sh
# Generate, capture, retry safely:
kash trade buy <id> --outcome 0 --amount 10 \
  --auto-idempotency-key --wait --json --quiet
```

### Retry-loop wrapper

`kash with-retry [opts] -- <command> [args...]` re-runs any kash
command when the structured error envelope reports a recoverable
failure. The retry policy reads `code` (`RATE_LIMITED`, `NETWORK`,
`TIMEOUT`, `MAINTENANCE`, `SERVER_ERROR` are retryable;
`INVALID_INPUT`, `AUTH_REQUIRED`, `NOT_FOUND` etc. fail fast) and
honours the `retryAfterMs` field when present, falling back to
exponential backoff otherwise.

```sh
# Retry up to 5 times, with the wait dictated by the server.
kash with-retry --max-attempts 5 -- markets list --status ACTIVE --json --quiet

# Idempotent retry across attempts (the inner key persists).
kash with-retry -- trade buy <id> --outcome 0 --amount 10 \
  --auto-idempotency-key --wait --json --quiet
```

The wrapped command MUST come after `--`. Without `--json`, the
wrapper falls back to a fixed exponential schedule (1s, 2s, 4s, …
capped at `--max-delay-ms`).

### Tracing a trade end-to-end

`kash trace <correlationId>` returns the curated event timeline for a
single trade — every event the pipeline emits as the trade moves through
intent parsing → funding → bridge → execution → webhook delivery.

```sh
# Get the correlation id from any trade response and trace it.
CID=$(kash trade buy <market-id> --outcome 0 --amount 10 --json --quiet | jq -r .correlationId)
kash trace "$CID"
```

The server returns a sanitized timeline — raw event payloads are never
exposed; only an allowlisted subset of fields (`txHash`, `tokensOut`,
`errorCode`, etc.) appears. JSON output is pinned to `GetTraceResponse`
(fetch the schema with `kash schema TraceResource --json`).

### Dry-run preview

Pass `--dry-run` to `kash trade buy/sell` to preview the request without
sending it. The CLI validates inputs, resolves the idempotency key, and
emits the would-be body — no API call, no auth required. Useful for
agents planning trades and humans sanity-checking before committing.

```sh
$ kash trade buy <id> --outcome 0 --amount 10 --dry-run --json
{
  "wouldSend": {
    "marketId": "9f0b…",
    "outcomeIndex": 0,
    "amount": "10",
    "side": "buy"
  },
  "idempotencyKey": null,
  "endpoint": { "method": "POST", "path": "/v1/trades" }
}
```

The envelope is pinned to `TradeDryRunEnvelope` — fetch the full Zod
schema with `kash schema TradeDryRunEnvelope --json`.

---

## Webhook signing

Kash webhooks are signed with HMAC-SHA256 in a Stripe-compatible format
(`X-Kash-Signature: t=<unix-ms>,v1=<hex>`). The SDK's `verifySignature`
helper handles parsing, replay-window enforcement, and constant-time
comparison.

```ts
import { KashClient } from '@kashdao/sdk';
const kash = new KashClient({}); // no apiKey needed for verifySignature

// In your HTTP handler — use the *raw* request body, not a re-serialised JSON.
const result = await kash.webhooks.verifySignature(rawBody, signatureHeader, secret);
if (!result.valid) {
  return res.status(400).send(result.reason);
}
```

Rotate the signing secret with `kash webhooks rotate-secret` (the new
plaintext is shown ONCE — capture it). See
[`examples/webhook-receiver.ts`](./examples/webhook-receiver.ts) for a
production-shaped Fastify receiver.

---

## Configuration reference

### Per-profile fields (in `~/.kash/config.json`)

| Field        | Type      | Default                   | Notes                                           |
| ------------ | --------- | ------------------------- | ----------------------------------------------- |
| `apiKey`     | `string?` | unset                     | Must start with `kash_`. Stored at mode `0600`. |
| `baseUrl`    | `string?` | `https://api.kash.bot/v1` | Validated as a URL.                             |
| `apiVersion` | `string?` | `2026-08-19`              | Public-API version pin (`YYYY-MM-DD`).          |

### Environment variables (override file)

| Variable           | Field               | Notes                                                     |
| ------------------ | ------------------- | --------------------------------------------------------- |
| `KASH_API_KEY`     | `apiKey`            | Highest precedence for the auth key.                      |
| `KASH_BASE_URL`    | `baseUrl`           |                                                           |
| `KASH_API_VERSION` | `apiVersion`        | `YYYY-MM-DD`. `--api-version` overrides it.               |
| `KASH_DEBUG`       | (mirrors `--debug`) | Set to `1`/`true`/`yes`/`on` to enable lifecycle traces.  |
| `KASH_PROFILE`     | (active profile)    | Equivalent to `--profile <name>` for the next invocation. |
| `KASH_CONFIG`      | (config path)       | Equivalent to `--config <path>`.                          |
| `NO_COLOR`         | (color output)      | Set to anything truthy to disable ANSI escapes.           |

### API versions

`apiVersion` defaults to `2026-08-19`, the version that serves Solana markets.
Pinning `2026-04-29` hides Solana markets from `kash markets list` and makes
`kash markets get` refuse them, so it cannot see any market open today.

```sh
kash config set apiVersion 2026-08-19
```

Each market names its chain in `chainRef` (`solana:mainnet-beta` in
production, `solana:devnet` on staging); `kash markets get` prints it.

**Upgrading from 0.2.x or earlier:** profile fields this version no longer
has are dropped when the file is read and removed from it on the next write:
the chain setting (`defaultChain`, or `defaultChainId` from 0.1.x) and the
direct-mode fields (`rpcUrl`, `smartAccount`, `bundlerUrl`,
`bundlerProvider`, `signerKeyRef`, `customChain`). Their environment variables
are no longer read. `kash config import` migrates old bundles the same way.
The `protocol` and `eoa` command groups are gone; trade, quote and redeem
through the API-backed commands.

### Resolution order

For each field, highest precedence first:

1. Environment variable.
2. Active profile in `~/.kash/config.json`.
3. Built-in default.

For the active profile name itself:

1. Explicit `--profile <name>` flag.
2. `KASH_PROFILE` environment variable.
3. `currentProfile` field in the config file.
4. `default`.

For the config file path itself:

1. Explicit `--config <path>` flag.
2. `KASH_CONFIG` environment variable.
3. `~/.kash/config.json`.

### Operational flags

| Flag                | Purpose                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <name>`  | Pick a stored credential profile.                                                                                                      |
| `--config <path>`   | Override `~/.kash/config.json` location.                                                                                               |
| `--debug`           | Stream SDK request/response/retry/error traces to stderr. With `--json` becomes NDJSON.                                                |
| `--base-url <url>`  | Override API base URL (staging tests, CI matrix builds).                                                                               |
| `--max-retries <n>` | Override SDK retry budget (0-10).                                                                                                      |
| `--timeout-ms <n>`  | Override SDK request timeout.                                                                                                          |
| `--json`            | Emit machine-readable JSON instead of human-formatted output.                                                                          |
| `--fields <list>`   | Project comma-separated dot-paths on `--json`/`--ndjson` output (e.g. `id,outcomes.label`). See [Field projection](#field-projection). |
| `--filter <expr>`   | Boolean predicate on `--json`/`--ndjson` entries (e.g. `'status==ACTIVE && outcomeCount>2'`). See [Filter DSL](#filter-dsl).           |
| `--quiet`           | Suppress spinners, progress, and informational logs.                                                                                   |
| `--no-color`        | Disable ANSI escapes (also honors `NO_COLOR`).                                                                                         |

### Field projection

Pass `--fields <list>` alongside `--json` or `--ndjson` to narrow output to
the dot-paths you care about. Reduces tokens for AI agents and noise for
shell pipelines, without spinning up `jq`.

```sh
# Top-level fields:
kash markets list --json --fields id,title,status

# Nested paths and array splay (entries inside arrays project per-element):
kash markets get <id> --json --fields title,outcomes.label,outcomes.tokenAddress

# Paginated envelopes preserve `pagination`/`meta` unchanged; only the
# `data` array entries are projected.
kash trade list --json --fields id,status,txHash --quiet | jq -c
```

### Filter DSL

Pass `--filter <expr>` alongside `--json` or `--ndjson` to keep only
entries matching a boolean predicate. Tiny DSL — `==`, `!=`, `<`,
`<=`, `>`, `>=`, `&&`, `||`, dotted field paths, numbers, booleans,
`null`, bare-word string values. Composes with `--fields`: filter
runs first, then projection narrows the survivors.

```sh
# Equality + comparison + boolean composition.
kash markets list --json --filter 'status==ACTIVE && outcomeCount>2'

# Filter on a dotted path.
kash trade list --json --filter 'webhookDelivery.status==delivered'

# Compose with --fields. The filter sees the FULL record; projection
# runs on what survives.
kash markets list --json --filter 'status==ACTIVE' --fields id

# NDJSON streams skip non-matching records entirely.
kash trade list --ndjson --filter 'side==buy && status==completed' | wc -l
```

Type-coerced equality means `outcomeCount==2` matches both `2` and
`"2"`. Ordered comparisons (`<`, `>`, `<=`, `>=`) require both sides
to be finite numbers; otherwise the entry fails the predicate. The
DSL is intentionally narrow — for richer queries, pipe `--json` through
`jq`.

Path syntax: comma-separated, dot-segmented. Segments must match
`[A-Za-z_][A-Za-z0-9_]*`. Missing paths drop silently (jq semantics).
The flag is a no-op for human output and for non-JSON commands.

### `--debug` trace shape

With `--debug --json`, each SDK lifecycle event is emitted to **stderr** as a
single line of NDJSON. Pipe stderr separately if your tooling expects clean
NDJSON on a single stream.

```jsonc
// onRequest
{ "event": "request", "method": "GET", "url": "/v1/markets", "attempt": 1, "idempotencyKey": null }
// onResponse
{ "event": "response", "method": "GET", "url": "/v1/markets", "attempt": 1, "status": 200, "durationMs": 142, "requestId": "req_abc" }
// onRetry
{ "event": "retry", "method": "POST", "url": "/v1/trades", "attempt": 2, "reason": "rate_limit", "delayMs": 1000 }
// onError
{ "event": "error", "method": "POST", "url": "/v1/trades", "attempt": 3, "status": 429, "code": "RATE_LIMIT_EXCEEDED", "durationMs": 87 }
```

`reason` is one of `rate_limit`, `server_error`, `network`, `timeout`. Without
`--json`, the same events are rendered as compact human-readable lines on
stderr.

---

## Stability promise

`@kashdao/cli` is currently `0.x` — under [Semantic Versioning](https://semver.org/)'s
own rules, `0.x` minor bumps may technically break anything. **We commit to
treating the contracts below as if SemVer-stable even before 1.0.** Additions
are minor bumps, behaviour changes or removals are major bumps. The 1.0
release will lock this in formally and remove the asterisk; until then, every
0.x release that ships will be reviewed against this list.

### Stable contracts

- **`--json` output shapes** for every command (validated by Zod schemas
  available via `kash schema --json`).
- **The CLI error envelope** (`kash schema CliErrorEnvelope --json`).
- **The version manifest shape** (`kash version --json`).
- **The `--debug` NDJSON trace shape** (documented above).
- **Exit codes** (`0` ok, `1` generic error, `2` auth failure).
- **Error `code` strings** in the catalog (`kash explain --json`). New codes
  appear in minor versions; existing codes never change meaning.
- **The `~/.kash/config.json` v1 file format**. Migrations to v2 will be
  automatic and forward-compatible.

### Not stable

- Human-mode (non-`--json`) output formatting (tables, prose, color choices).
  Scripts that rely on it should switch to `--json --quiet`.
- Internal module structure (`packages/cli/src/`); only the binary surface
  is the public API.
- Help text wording.

### Deprecation policy

Behaviour changes that don't break the stable contracts are minor bumps
without warning. Anything that does will:

1. Be announced in the `CHANGELOG.md` of the deprecating release.
2. Continue to work for at least one minor version.
3. Emit a stderr warning when used (humans only; agents using `--json` see
   no functional change until the major bump).

---

## Troubleshooting

### `[AUTH_REQUIRED] No API key configured.`

You haven't set an API key. Run `kash auth set-key kash_live_…`
(create a key under Settings → API Keys at https://app.kash.bot) or set
`KASH_API_KEY` in your environment. Every authenticated command needs
a key — only `kash --version`, `kash --help`, and `kash explain <code>`
work fully offline.

### `[INVALID_INPUT] --max-retries must be …`

CLI flag values are validated up front. The error envelope's `actions[0]`
of type `check_input` names the bad field. Look up the constraints in
the [Operational flags](#operational-flags) table or run
`kash <command> --help`.

### `[RATE_LIMITED]` with `retryAfterMs`

You're over your tier's rate limit. The error envelope tells you exactly
how long to wait. Either honor it programmatically (see
[`examples/trade-replay.sh`](./examples/trade-replay.sh)) or upgrade at
https://kash.bot/pricing.

### `[CONFLICT]` on `kash trade buy/sell`

A duplicate Idempotency-Key, the trade is awaiting high-value confirmation,
or the market closed between fetch and order. Inspect with
`kash trade status <id>` before retrying.

### `[NETWORK]` or `[TIMEOUT]`

Network path issues. The CLI already retries automatically; this means
retries were exhausted. Check connectivity to `api.kash.bot`. Retry with
`--timeout-ms 60000 --max-retries 5` if your environment has latency
spikes.

### `[CONFIGURATION] Config file at … is invalid`

The on-disk `~/.kash/config.json` is malformed. The error message names
the field. Run `kash config reset` to start fresh, or hand-edit the file
(it's valid JSON).

### Diagnosing any other failure

Run with `--debug` to see SDK request/response/retry traces. With
`--debug --json` you get NDJSON on stderr — pipe it through `jq` to inspect
the request flow:

```sh
kash trade buy … --debug --json --quiet 2> >(jq .)
```

Capture `kash version --json` for issue triage:

```sh
kash version --json
# {
#   "cli": "0.1.0",
#   "sdk": "0.1.0",
#   "node": "v22.4.1",
#   "platform": "darwin",
#   "release": "23.6.0",
#   "arch": "arm64"
# }
```

Run `kash explain <code>` for any error code to get the catalog entry
including recommended recovery actions. File a bug at
https://github.com/KashDAO/cli/issues with the version manifest, the
`requestId` from the failing envelope, and the failing command.

---

## Examples

Worked recipes for both human scripts and AI agents in
[`examples/`](./examples/):

| File                  | Audience              | Demonstrates                                                                                      |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `buy-and-follow.sh`   | Bash scripts, CI      | Place a trade, block on settlement with `--wait`, parse the tx hash from `--json --quiet` output. |
| `trade-replay.sh`     | Reliability engineers | `--auto-idempotency-key` for safe retries; capture and reuse the generated key on failure.        |
| `portfolio-export.sh` | Data ops, accountants | Stream all positions and trades as NDJSON; pipe through `jq` for filtering.                       |
| `webhook-receiver.ts` | Backend engineers     | Production-shaped Fastify receiver verifying `X-Kash-Signature` with `verifySignature`.           |
| `ai-agent.py`         | LLM/agent engineers   | Python loop calling `kash --json --quiet`, recovering from errors via `kash explain`.             |
| `agent-discovery.py`  | LLM/agent engineers   | Use `kash docs --json` and `kash schema` to teach an agent the CLI surface at startup.            |

---

## Development

```sh
pnpm --filter @kashdao/cli build
pnpm --filter @kashdao/cli test:unit
pnpm --filter @kashdao/cli typecheck
pnpm --filter @kashdao/cli lint
```

Run the bundled binary against a local API:

```sh
KASH_BASE_URL=http://localhost:3001/v1 \
KASH_API_KEY=kash_test_… \
node packages/cli/dist/index.js markets list
```

The CLI ships as a single ESM bundle (~85 KB) with an executable
shebang. Dependencies pinned in `package.json`: `commander`, `chalk`,
`cli-table3`, `omelette`, `ora`, `zod`, `zod-to-json-schema`, plus
`@kashdao/sdk` (workspace).

## Reporting issues / security

- General bugs: https://github.com/KashDAO/cli/issues
- Security disclosures: see [`SECURITY.md`](./SECURITY.md). Email
  `security@kash.bot`; do not file a public issue.

## License

MIT — see [`LICENSE`](./LICENSE).
