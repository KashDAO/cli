# Security policy

## Non-custodial design

`@kashdao/cli` is **non-custodial software**. The following invariants
hold across both of its execution modes (Kash-orchestrated and
self-orchestrated):

- **Kash never holds or controls user funds.** Customer USDC,
  outcome tokens, and any other on-chain assets always sit at an
  on-chain address the user controls. The CLI holds zero balances on
  the user's behalf; the Kash backend holds zero balances on the
  user's behalf.
- **Kash never has access to user signing keys.** Smart-account keys
  are split via Privy's MPC across the user's device and Privy's
  HSM-backed enclave; Kash operates no key share. In self-orchestrated
  mode the user's private key lives wherever they put it (file ref,
  env var, KMS, Fireblocks, hardware wallet) and never leaves the
  CLI process boundary.
- **The CLI never persists user keys.** API keys persist to
  `~/.kash/config.json` at mode `0600`; raw private keys are never
  written to disk by the CLI. The `signerKeyRef` config field is a
  _reference_ (`file:<path>` / `env:<NAME>`) — the underlying secret
  is resolved at invocation time and never persisted by the CLI.
- **Kash never signs transactions or UserOps on the user's behalf.**
  Every state-changing on-chain action is signed inside the user's
  Privy MPC enclave or by the consumer's own signer; no signature ever
  originates on a Kash server or inside the Kash backend's process
  boundary.
- **Kash never moves user funds.** Settlement is on-chain via
  open-source protocol contracts; there is no Kash-controlled pool of
  funds in the path, no Kash-controlled balance ledger, and no
  Kash-controlled relay that can re-route value.
- **The API-key delegation is scoped and revocable.** A `kash_live_*`
  / `kash_test_*` key carries narrowly-scoped limits (per-trade caps,
  daily caps, allowed operations, allowlisted IPs) the customer sets
  themselves. Revocation via `kash auth revoke <id>` (or the Kash
  dashboard) takes effect on the next request.
- **Kash is not a money-services business, custodian, exchange, or
  broker-dealer.** Kash publishes software and protocol contracts;
  customers run the software and interact with the protocol from
  accounts they control.

Equivalent statements hold for `@kashdao/sdk`, `@kashdao/protocol-sdk`,
and `kashdao-protocol-sdk` (Python).

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
