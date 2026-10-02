# Changelog

All notable changes to `@kashdao/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the package is `0.x`, minor versions may include breaking changes —
breaking changes are explicitly called out in the entry. See the
**Stability promise** section of `README.md` for what is and is not part
of the SemVer-stable contract.

The runtime contract surface (error envelope, version manifest, config
envelope, command tree) is also pinned by `tests/unit/contracts.test.ts`
— any drift there forces a deliberate update to both the schema and
the test, which surfaces in this changelog.

## [Unreleased]

## [0.2.1] — 2026-10-02

**0.2.0 was tagged but never published to npm.** 0.2.1 is its first published
form: every change listed under 0.2.0 below — including its breaking changes
and the downgrade note — ships here. It depends on `@kashdao/sdk` 0.2.1 and
`@kashdao/protocol-sdk` 0.3.2, the first published forms of the SDK releases
0.2.0 was built against.

### Fixed

- **The SDK dependencies are caret ranges in the published package.** 0.1.1
  declared `@kashdao/sdk` and `@kashdao/protocol-sdk` as exact versions
  (`0.1.1`), so an install never picked up an SDK patch (`@kashdao/sdk` 0.1.3
  included) without a new CLI release — while the public mirror's
  `package.json` declares caret ranges. 0.2.1 declares `^0.2.1` and `^0.3.2`
  on npm too, and the publish script now
  packs the tarball once, refuses it unless both ranges are carets on the
  current SDK versions, and uploads that same tarball.
- The `KASH_CHAIN_ID` refusal names 0.2.1, the first published release that
  replaced it with `KASH_CHAIN`.

## [0.2.0] — 2026-10-01

Solana is Kash's canonical chain from 2026-10-01. This release makes the CLI
see it by default. **Breaking** (a `0.x` minor): the config and JSON envelope
change shape, with an automatic migration for existing config files.

**Where Solana visibility comes from:** the API-version pin, not the chain
setting. The API-backed commands (`kash markets`, `kash quote`, `kash trade`,
`kash redeem`, `kash portfolio`) see every market the pinned API version
serves, Solana and Base alike, whatever `defaultChain` says. `defaultChain` is
**display-only in API mode**; it only selects a chain for `kash protocol` and
`kash eoa`.

**Downgrade note:** a config file rewritten by 0.2.0 (any `kash config set`,
`kash auth set-key` or `kash config import`) stores `defaultChain` and may
store `apiVersion`, and 0.1.x's strict config schema rejects both. To go back
to 0.1.x, remove those keys from `~/.kash/config.json` (and set
`defaultChainId` if you need it), or run `kash config reset`.

### Changed

- **BREAKING: depends on `@kashdao/sdk` 0.2.0**, which pins API version
  `2026-08-19`, and the CLI now always sends the resolved API version. That pin
  is what makes `kash markets list` include Solana markets and `kash markets
get` / `kash quote` serve them instead of failing with `CHAIN_NOT_SUPPORTED`.
  Pinning `2026-04-29` (`--api-version`, `KASH_API_VERSION` or the profile's
  `apiVersion`) hides them again regardless of `defaultChain`.
- **BREAKING: `defaultChainId` (number) is replaced by `defaultChain`, a chain
  reference** — `solana:mainnet-beta` (the new default), `solana:devnet`,
  `evm:8453` — the spelling the API returns in `chainRef`. `kash config set
defaultChain` also accepts a bare numeric EVM chain id (stored as `evm:<n>`)
  and the CAIP-2 `eip155:<n>` spelling, normalised to `evm:`. Existing
  `~/.kash/config.json` files migrate transparently on read (`8453` →
  `evm:8453`) and are rewritten in the new shape on the next write;
  `kash config import` migrates 0.1.x bundles the same way. In API mode the
  value is display-only (shown by `kash config show` / `kash auth status`); it
  selects the chain only for `kash protocol` and `kash eoa`. See the downgrade
  note above before going back to 0.1.x.
- **BREAKING: `KASH_CHAIN_ID` is replaced by `KASH_CHAIN`** (chain reference or
  numeric EVM id). The CLI refuses to run while `KASH_CHAIN_ID` is set, naming
  the replacement, rather than silently moving a CI job onto the Solana default.
- **BREAKING: `kash config show --json` and `kash auth status --json`** emit
  `defaultChain` and `apiVersion` in place of `defaultChainId`, and
  `sources.defaultChain` / `sources.apiVersion` in place of
  `sources.defaultChainId`. `CliConfigEnvelopeSchema` is updated to match.
- `kash markets get` prints the market's chain reference. 0.1.x printed
  `String(market.chainId)`, which read `undefined` for every Solana market.
  `kash markets list` gains a **Chain** column.
- `kash portfolio show` labels the address **Wallet**: it is a base58 Solana
  wallet for a user whose funds live on Solana.
- `--outcome` accepts indexes `0`-`99` on every command. Markets carry 2-100
  outcomes; the old `0`-`7` ceiling refused every outcome past the eighth.
- `kash protocol …` and `kash eoa …` are labelled **EVM/Base only** in their
  help. They are unchanged in behaviour: they run on `defaultChain` when it is
  an `evm:` chain and on Base mainnet otherwise, which is what 0.1.x's
  `defaultChainId: 8453` default did. A `customChain` profile must name an
  `evm:` chain.

### Added

- **`kash redeem <marketId> --outcome <i>`** — redeem a settled position
  (`POST /v1/redemptions`), on Solana or Base. Requires the `trades:write`
  scope. Mirrors `kash trade buy|sell`: `--idempotency-key <key>`,
  `--auto-idempotency-key` (generates a UUID v4), and `--dry-run` (prints the
  would-be body, endpoint and key without sending or needing an API key). The
  idempotency key used is printed, and included in `--json` output, so a retry
  can reuse it; with neither flag the SDK keys the request itself.
  `POSITION_NOT_CLAIMABLE` covers both an unredeemable position and a previous
  redemption that failed and must be cleared by support; the message says
  which.
- **Per-profile `apiVersion`** (`kash config set apiVersion 2026-08-19`) and
  the `KASH_API_VERSION` env var. Precedence: `--api-version` flag, then the
  env var, then the profile, then the SDK's pinned default (`2026-08-19`). The
  resolved version is now always sent; 0.1.x sent none unless the flag was set.

## [0.1.1] — 2026-06-18

### Changed

- **Mainnet GA.** The production API (`api.kash.bot`) is live and API
  keys are issued self-service under **Settings → API Keys** in the Kash
  app. Onboarding text, `kash setup`, error suggestions
  (`AUTH_REQUIRED`, `INSUFFICIENT_SCOPE`), `kash health`, and the README
  no longer reference the staging-only release or email-based key
  requests. No behaviour change: a `kash_live_*` key already auto-routes
  to production and `kash_test_*` to staging.

## [0.1.0] — 2026-05-20

Initial public release.

### Added

- **`kash setup`** — interactive first-run wizard (masked API key
  prompt, profile selection, shell-completion install, health probe,
  scope canary). Non-interactive via `--yes --api-key <key>`. Re-runnable
  on existing configs (updates, not duplicates).
- **Multi-profile support** — `~/.kash/config.json` holds named profiles
  (`default`, `live`, `test`, etc.). Switch via `--profile <name>`,
  `KASH_PROFILE=<name>`, or `kash config use <name>`. Per-profile
  `apiKey`, `baseUrl`, `defaultChainId`, plus protocol-mode fields
  (`rpcUrl`, `smartAccount`, `bundlerUrl`, `bundlerProvider`,
  `signerKeyRef`, `customChain`).
- **Auto-routing** — a `kash_test_*` API key auto-routes to staging
  (`api-staging.kash.bot`); a `kash_live_*` key routes to production
  (`api.kash.bot`). Mirrors `@kashdao/sdk`'s `inferBaseUrlFromApiKey()`.
  Explicit `--base-url` or `KASH_BASE_URL` always wins.
- **Two orchestration modes — both fully non-custodial.** On every
  path: Kash never holds funds, never moves funds, never holds keys,
  and never signs anything. User funds always live in accounts the
  user controls. See SECURITY.md § Non-custodial design for the full
  statement.
  - **Kash-orchestrated (default)** — uses the Kash public REST API
    (`kash markets`, `kash quote`, `kash trade`, `kash portfolio`,
    `kash webhooks`, `kash auth`, `kash trace`, `kash account`). The
    API key is a scoped, revocable delegation the user issues against
    their own Privy-managed smart account.
  - **Self-orchestrated (`kash protocol ...`)** — wraps
    `@kashdao/protocol-sdk` (signer + RPC + bundler all consumer-side).
    Zero Kash backend dependency. Lazy-loaded — adds no cold-start
    cost for users who stay on the Kash-orchestrated path.
- **JSON-everywhere** — every command accepts `--json` for a stable
  machine-readable envelope (single object on stdout, errors on stderr).
  `kash docs --json` returns the full command tree for tooling.
- **Idempotency** — `--auto-idempotency-key` on trade commands, or pass
  `--idempotency-key <uuid>` manually. Replays return the cached
  response.
- **Webhook ops** — `kash webhooks list`, `redeliver <eventId>`,
  `rotate-secret`, `replay <file>` (offline signature preview).
- **Trade lifecycle** — `kash trade buy/sell`, `--dry-run` preview,
  `--wait` polling until terminal, `kash trade status <id>`,
  `kash trade confirm <id> --token <token>` for high-value flows,
  `kash trade list --filter`.
- **High-value confirmation flow** — gracefully handles
  `pending_confirmation` responses with a `--token` prompt or
  `--auto-confirm` for trusted contexts.
- **`kash trace <correlationId>`** — end-to-end request-id trace from a
  trade or webhook delivery, walks the event chain across services.
- **Typed errors + recovery hints** — every error includes a code, a
  recovery suggestion (e.g., DNS errors against `api.kash.bot` suggest
  using a test key), and a `kash explain <CODE>` reference.
- **Shell completion** — bash, zsh, fish via the `omelette` integration.
  Installed during `kash setup` (skippable with `--yes`).
- **Cross-platform install** — npm (`npm i -g @kashdao/cli`), pnpm,
  or yarn. A Homebrew tap (`kashdao/tap`) is planned for the
  production launch.
