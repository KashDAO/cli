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
