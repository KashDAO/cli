# Contributing to `@kashdao/cli`

Thanks for considering a contribution. The CLI is the customer-facing
entry point for both humans and AI agents using the Kash API — every
behaviour here is something an integration may have pinned, so we hold
the bar high.

## How development works

This repo (`KashDAO/cli`) is the **public mirror** of the CLI. The
canonical source lives inside Kash's private monorepo, and is synced
to this repo on every release. Pull requests land here in the public
mirror, get reviewed, and once accepted are re-imported into the
monorepo.

That's the same model Stripe (`stripe/stripe-cli`), GitHub
(`cli/cli`), and AWS use — public client, private server.

What that means in practice:

- ✅ Open issues and PRs in this repo.
- ✅ Comment on PRs, request changes, propose alternatives.
- ❌ The full Kash backend isn't visible from this repo. The CLI
  speaks to `https://api.kash.bot/v1` like any other consumer (or
  directly on-chain for `kash protocol …` and `kash eoa …`).

## Quick start

```sh
git clone https://github.com/KashDAO/cli.git
cd cli
pnpm install
pnpm build
pnpm test
node dist/index.js --version
```

Requires Node 22+ and pnpm 9+.

## What's in scope

✅ Welcome:

- Bug fixes — especially in error envelope construction, output
  formatting, and the contract surface (`kash version`,
  `kash schema`, `kash docs`, `kash explain`).
- New examples under `examples/` for novel integration patterns.
- Better help text, JSON schema docs, and `--help` examples.
- Test coverage for edge cases (TTY detection, NDJSON streaming,
  signal handling, BOM-aware stdin).
- Cold-start performance (stay lazy on heavy deps).

🟡 Discuss first (open an issue):

- New commands or subcommands.
- New flags on existing commands.
- Changes to the contract surface — `CliErrorEnvelopeSchema`,
  `VersionManifestSchema`, `CliConfigEnvelopeSchema`, the
  `CliCapabilitySchema` enum, or any `kash *--json` shape that
  agents may have pinned.
- New error codes in `src/error-catalog.ts` or changes to existing
  recovery `actions[]`.
- Bumping the minimum Node version.

❌ Out of scope:

- Wrapping the CLI in a programmatic Node API. Use
  [`@kashdao/sdk`](https://www.npmjs.com/package/@kashdao/sdk) or
  [`@kashdao/protocol-sdk`](https://www.npmjs.com/package/@kashdao/protocol-sdk)
  directly — the CLI exists for shells and agents, not as a library.
- New runtime dependencies. The bundle is small by design; if you
  need a small utility, write it inline.
- Auto-formatters / lint plugins beyond what `eslint.config.js`
  already configures.

## Standards

- **Stable JSON contracts.** Every `--json` output is pinned to a
  Zod schema in `src/cli-schemas.ts`. Adding a field is a minor
  bump; removing or renaming one is a breaking change. Both are
  flagged by `tests/unit/contracts.test.ts`.
- **Two audiences, both first-class.** Humans get colored tables,
  spinners, and tab completion; agents get `--json --quiet` with
  structured errors. Don't optimise one path at the cost of the
  other.
- **Errors are typed.** Throw `CliError` / `CliValidationError` from
  `src/errors.ts`; never throw plain `Error`. Every code in
  `src/error-catalog.ts` carries a `recoverable` flag and an
  `actions[]` array of recovery hints.
- **Output through `src/utils/output.ts`.** Direct `console.log`
  bypasses `--quiet` handling and chalk detection. The ESLint config
  enforces this everywhere except inside `output.ts` itself.
- **Lazy-load heavy deps.** Cold start matters. The protocol-sdk and
  viem are loaded only on the first `kash protocol …` or
  `kash eoa …` invocation. Don't add top-level imports of `viem` or
  `@kashdao/protocol-sdk` to commands that don't need them.
- **`run_command` actions with `<placeholder>` tokens MUST set
  `template: true`.** Agents auto-shell concrete commands; templated
  ones are surfaced for substitution. The contract test enforces
  this.

## Workflow

1. **Fork** this repo and create a feature branch:
   `git checkout -b feat/add-xyz`.
2. **Make the change.** Run `pnpm typecheck`, `pnpm lint`, and
   `pnpm test` after each substantial edit.
3. **Add tests.** Cover happy path + at least one failure mode.
   If you touch a schema in `src/cli-schemas.ts`, update
   `tests/unit/contracts.test.ts` to pin the new shape.
4. **Document.** Update the README, the `kash <cmd> --help` text,
   and `CHANGELOG.md` under `[Unreleased]`.
5. **Open a PR** with a short summary explaining the _why_, not
   just the _what_. Link any related issue.

There is **no automated CI on this public mirror** for v0.x — the
maintainers run typecheck, lint, the unit + component suite, and
the runtime smoke (`scripts/runtime-smoke.mjs`) locally before
merging your PR.

## Testing

```sh
pnpm test                 # unit + component
pnpm typecheck
pnpm lint
pnpm build && node scripts/runtime-smoke.mjs   # built-binary smoke
```

The component suite under `tests/component/` drives the real binary
through Commander; no API mocks are needed for the contract surface.
The unit suite under `tests/unit/` covers envelope shapes, the error
catalog, install-script behaviour, and per-command flag matrices.

`tests/unit/contracts.test.ts` is the gatekeeper for the SemVer-stable
contract surface. If your PR causes a failure there, the contract
shape has drifted — update both the schema in `src/cli-schemas.ts`
AND the contract test deliberately, document the change in CHANGELOG,
and call it out in the PR description.

## Commit messages

Conventional commits:

```
feat: add `kash mcp serve` (Model Context Protocol)
fix: honour --quiet on early SIGPIPE
docs: document --refuse-private-addresses on webhooks replay
test: cover the BOM-aware stdin path
```

(No scope needed — everything here is the CLI.)

## Questions

- General product questions: [GitHub Discussions](https://github.com/KashDAO/cli/discussions)
- Security vulnerabilities: see [SECURITY.md](./SECURITY.md) —
  please don't open public issues for security findings.
- Anything else: open an issue and we'll route it.
