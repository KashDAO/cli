# Security policy

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
