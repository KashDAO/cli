# Security policy

## Non-custodial design

Kash is an interface to a decentralized, permissionless prediction-market
protocol on Solana. `@kashdao/cli` is a command-line client for the Kash
public API.

- **Kash never holds custody of user funds.** USDC and outcome tokens sit
  in a wallet the user owns. Neither the CLI nor Kash holds balances on
  the user's behalf.
- **Users own their wallets and assets.** Trades settle on-chain through
  the open protocol program, directly between the user's wallet and the
  market.
- **API trades run under a permission the user grants.** When you trade
  through the CLI, Kash submits the transactions you request from your
  wallet, using a scoped permission you grant when you create an API key.
- **The CLI never stores private keys.** Only your API key is stored, in
  `~/.kash/config.json` at mode `0600`.
- **The permission is scoped and revocable.** A `kash_live_*` /
  `kash_test_*` key is limited to the scopes and settings (such as an IP
  allowlist) configured on it. Revocation in the Kash app (Settings → API
  Keys) takes effect on the next request.

## Reporting a vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Email: `security@kash.bot`

Include:

- A clear description of the issue
- Reproduction steps or proof-of-concept
- The version of `@kashdao/cli` (and any relevant runtime info: Node version,
  shell, OS)
- Whether the issue affects the CLI, the underlying SDK, the public API,
  or some combination

We aim to:

1. Acknowledge receipt within **2 business days**.
2. Confirm or reject the report within **7 business days**.
3. Ship a fix within **30 days** for accepted reports, faster for issues
   actively being exploited.

Once the fix has shipped and a reasonable upgrade window has elapsed, we
publish a coordinated disclosure crediting the reporter (with consent).

## Scope

In scope:

- Vulnerabilities in `@kashdao/cli` itself (this package).
- Issues that compromise the security guarantees of the local CLI surface:
  - API key leakage to disk in plaintext outside `~/.kash/config.json`
  - `~/.kash/config.json` being created or rewritten with permissions
    looser than `0600` on POSIX systems
  - Shell completion files being installed without user consent
  - JSON output containing API keys, webhook secrets, or other plaintext
    credentials when not explicitly requested
  - Path-traversal or arbitrary-file-write through any CLI argument

Out of scope (please report to `security@kash.bot` separately if relevant):

- Vulnerabilities in `@kashdao/sdk` — see that package's `SECURITY.md`
- Vulnerabilities in the Kash public API
- Vulnerabilities in transitive dependencies (`commander`, `chalk`,
  `cli-table3`, `ora`, `omelette`, `zod`) — report upstream first; we'll
  respond to coordinated disclosures
- Issues requiring physical access to the user's machine, or the user
  having already lost local credentials
- Permission tightening failing on Windows or non-POSIX filesystems
  (chmod is best-effort; documented in `src/utils/config-store.ts`)

## Supported versions

| Version | Supported            |
| ------- | -------------------- |
| 0.x     | ✅ Latest minor only |

While the package is `0.x`, only the latest published `0.x.y` receives
security fixes. After 1.0, we'll publish a long-term-support policy here.

## Disclosure

Acknowledged researchers are listed in `CHANGELOG.md` against the patched
release.
