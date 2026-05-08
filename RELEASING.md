# Releasing `@kashdao/cli`

The CLI ships from the private monorepo to the public mirror at
`KashDAO/cli` and from there to npm. This document is the runbook.

> **Audience**: maintainers inside the Kash monorepo. The mirror repo
> has its own `CONTRIBUTING.md` for external contributors.

## Pattern: public client, private server, manual publish

Same model as `@kashdao/sdk` and `@kashdao/protocol-sdk` — the three
packages share a release shape so a single muscle memory covers all
of them.

- **Canonical source**: the CLI lives at `packages/cli/` inside the
  private Kash monorepo. All development happens there.
- **Public mirror**: `github.com/KashDAO/cli` is a one-way mirror of
  the CLI package directory. External contributors open PRs against
  the mirror; accepted PRs are re-imported into the monorepo by hand.
- **npm artifact**: published manually as `@kashdao/cli` via
  `scripts/publish.sh` — no CI/CD on the CLI side for v0.x to keep
  the publish path simple and predictable while the team gets
  comfortable with the flow.

Future tightening (post-1.0 candidate): npm trusted publishing via
OIDC. Out of scope for now.

## Pre-requisite: SDK + protocol-sdk on npm

The CLI's published tarball declares runtime deps on
`@kashdao/sdk@^X.Y.Z` and `@kashdao/protocol-sdk@^X.Y.Z`. **Both must
be on npm at the matching versions before the CLI publishes** —
otherwise every `npm i -g @kashdao/cli` fails with "no matching
version".

`scripts/publish.sh` enforces this. Order of operations for a
synchronised release:

1. Bump SDK + protocol-sdk versions if needed; sync + publish them
   first via their respective `scripts/publish.sh`.
2. Bump the CLI's `package.json#version` and `src/version.ts`
   (`CLI_VERSION`) in lockstep.
3. Sync the CLI mirror.
4. Publish the CLI.

## Branches and tags

- `main` on the **mirror** is the source of truth for what's
  published. Every commit on `main` is a state the CLI was, is, or
  will be in.
- Tags `v0.1.0`, `v0.2.0`, etc. on the mirror mark released
  versions. Tags don't trigger any automation today.
- Tags inside the **monorepo** are not published.

## Release workflow

### 1. Land changes inside the monorepo

Normal monorepo PR workflow against `packages/cli/`. Internal CI
runs:

- `pnpm --filter @kashdao/cli typecheck`
- `pnpm --filter @kashdao/cli lint`
- `pnpm --filter @kashdao/cli test` — includes
  `tests/unit/contracts.test.ts` which catches drift in the
  SemVer-stable contract surface.

### 2. Bump the version

Inside the monorepo, edit two files in lockstep:

- `packages/cli/package.json#version`
- `packages/cli/src/version.ts` (`CLI_VERSION`)

The component test in `tests/component/agent-surface.test.ts`
asserts the two stay in sync via `kash version --json`.

Update `packages/cli/CHANGELOG.md`: rename `[Unreleased]` to the new
version + date, leave a fresh empty `[Unreleased]` heading on top,
and update the compare/release link footer.

Land on monorepo `main`.

### 3. Sync to the mirror

```sh
pnpm tsx packages/cli/scripts/sync-to-public-mirror.ts \
  --mirror-url=git@github.com:KashDAO/cli.git
```

> **HTTPS auth?** If your git config delegates GitHub HTTPS auth via
> `gh auth git-credential` (the default after `gh auth setup-git`),
> make sure no stale `GITHUB_TOKEN` env var is shadowing your keyring
> credentials. `gh auth status` flags it. Either `unset GITHUB_TOKEN`
> in your shell, run `gh auth switch -h github.com -u <user>` to
> activate the keyring account, or prefix the sync command with
> `env -u GITHUB_TOKEN`.

What the script does:

1. Clones the mirror into a temp dir.
2. Wipes the mirror working tree (preserving `.git`).
3. Copies `src/`, `tests/`, `examples/`, `scripts/`, `.github/`,
   README.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, LICENSE,
   RELEASING.md, tsup.config.ts, eslint.config.js, and `.gitignore`.
4. Drops monorepo-only test files (`*.private.test.ts`) and the
   sync script itself (it's monorepo-bound by construction).
5. Writes a standalone `tsconfig.json`, `vitest.config.ts`, and
   `package.json` (workspace devDeps stripped; workspace runtime
   deps `@kashdao/sdk` and `@kashdao/protocol-sdk` rewritten to
   `^<published-version>` from their respective `package.json`s).
6. Commits with message `release: v<version>` and tags `v<version>`.
7. Pushes `main` + the tag to the mirror.

`--dry-run` prepares the mirror tree without committing or pushing.
`--skip-push` commits + tags locally but doesn't push.
`--local-output=<path>` skips the clone entirely and just writes the
prepared mirror tree to a local directory — best for inspection.

#### Before the FIRST publish (squash initial commit)

The normal sync flow commits a fresh release on top of whatever
history the mirror already has. For the **first** publish you want
the mirror's history to start with a single, clean
`initial public release` commit — not a trail of internal cleanup.
One-shot recipe:

```sh
# Materialise a clean mirror tree locally (no clone, no commit)
pnpm tsx packages/cli/scripts/sync-to-public-mirror.ts \
  --local-output=/tmp/cli-init

cd /tmp/cli-init
git init -b main
git add -A
git commit -m "chore: initial public release of @kashdao/cli"
git remote add origin git@github.com:KashDAO/cli.git

# Mirror has no external consumers yet — force-push is safe here
# and only here. Every subsequent release goes through the normal
# sync-to-public-mirror.ts flow (clone + copy + commit + tag + push).
git push --force origin main
```

After this one-time push, every subsequent release uses the normal
`sync-to-public-mirror.ts` flow and the mirror history grows linearly
from the initial commit.

### 4. Publish to npm (manual)

#### Dry-run first

Always dry-run before the real publish:

```sh
bash packages/cli/scripts/publish.sh --dry-run
```

The dry-run runs every gate (typecheck, lint, test, build, runtime
smoke, SBOM, SDK + protocol-sdk pin verification) plus the
CHANGELOG-slice extraction for the GitHub Release — but stops short
of `npm publish` and `gh release create`. The dry-run is
non-interactive and tolerates "version already published" + "not
logged in to npm" — it warns and keeps going.

Important for the CLI: the dry-run still verifies that
`@kashdao/sdk` and `@kashdao/protocol-sdk` are reachable on npm at
the versions the CLI tarball will pin to. If either is missing,
the dry-run fails fast (in real publish too) — that's the order-of-
operations gate.

#### Real publish

```sh
bash packages/cli/scripts/publish.sh
```

The script:

1. Verifies you're logged in to npm (`npm whoami`).
2. Confirms the version isn't already published.
3. Confirms `@kashdao/sdk@<sdk-version>` and
   `@kashdao/protocol-sdk@<protocol-sdk-version>` are reachable on
   npm at the versions the CLI's tarball will pin to.
4. Re-runs the pre-publish gate (typecheck, lint, test, build,
   runtime smoke).
5. Asks for an interactive `yes` confirmation.
6. Runs `npm publish --access public --ignore-scripts`.

You'll be prompted for 2FA during the actual publish step.

### 5. Create the GitHub Release

The mirror has no automated release drafting. After each publish,
manually:

1. Visit `https://github.com/KashDAO/cli/releases/new`.
2. Choose the tag the sync script pushed (e.g. `v0.1.0`).
3. Set release title to the version (`v0.1.0`).
4. Paste the relevant `CHANGELOG.md` section into the description.
5. Publish release.

### 6. Smoke-test from a clean environment

```sh
mkdir /tmp/kash-cli-smoke && cd /tmp/kash-cli-smoke
npm install -g @kashdao/cli@<version>
kash --version          # expect: <version>
kash version --json     # expect: VersionManifestSchema-shaped JSON
kash schema --json | jq 'keys'   # expect: array of Schema names
```

If those produce the expected output, the release is real.

### 7. Update the Homebrew tap (if applicable)

The Homebrew formula template lives at
`packages/cli/scripts/homebrew/kash.rb`. Render it with the
just-published version and tarball SHA:

```sh
bash packages/cli/scripts/homebrew/render-formula.sh <version>
```

…then commit the rendered formula to `KashDAO/homebrew-tap`.

## Hotfix process

Same flow, but tag a patch version (`v0.1.1`) from a hotfix branch
in the monorepo. Bump `package.json` + `src/version.ts`, sync to
mirror, run the publish scripts in the same order. No special
handling — patch releases go through the same gates.

## Backporting external PRs

The mirror accepts PRs from external contributors. Once merged into
mirror `main`:

1. Cherry-pick the commit into `packages/cli/` in the monorepo.
2. Adjust paths if needed (the mirror has no `packages/cli/` prefix).
3. Re-run the monorepo tests (including any `*.private.test.ts`).
4. Land normally.

The next release sync will pick it up.

## Required access

| Resource                       | Who needs access                |
| ------------------------------ | ------------------------------- |
| npm `@kashdao` scope (publish) | Whoever runs the publish script |
| `KashDAO/cli` repo (push)      | Whoever runs the sync script    |

For a team, hand the publish credentials to a single release captain
to keep the audit trail clean.

## Rollback

If a published version is broken:

1. Deprecate it: `npm deprecate @kashdao/cli@<version> 'Broken — use <newer>'`.
2. **Do not** `npm unpublish` — semver-major versions are
   unpublishable after 24h regardless, and unpublishing breaks
   consumers' lockfiles.
3. Ship a patch release with the fix following the normal flow.

## SemVer policy

While `0.x.y`:

- Minor bumps may include breaking changes — documented in CHANGELOG.
- Patch bumps are bug fixes only.

After 1.0, the SemVer-stable surface is everything in
`tests/unit/contracts.test.ts`:

- Major: breaking change to any pinned envelope, capability flag
  removal, or command rename.
- Minor: new commands, new flags, new capability flags, new error
  codes (additive only).
- Patch: bug fixes, doc improvements, internal refactors.

## Future: when CI lands

Once we're comfortable with the manual flow, candidates for
automation:

- **npm trusted publishing** via OIDC. Adds the npm signed-attestation badge.
- **`kash mcp serve`** integration tests on tagged releases.
- **Cross-platform binary smoke** matrix (macOS arm64, Linux amd64,
  Windows) via GitHub Actions.

Deferred until the manual flow has been exercised a few times.
