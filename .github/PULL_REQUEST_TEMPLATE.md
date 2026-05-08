<!--
  Thanks for contributing! Please fill in the sections below.
  See CONTRIBUTING.md for the full standards we hold PRs to.
-->

## What

<!-- One-sentence description of the change. -->

## Why

<!-- The user-visible problem this solves. NOT "what the code does" — that's "What" above. -->

## Risk / blast radius

<!--
  Be honest. Examples:
  - "Internal refactor; no behaviour change"
  - "Adds a new subcommand; backwards compatible"
  - "Renames a flag — breaking for scripted consumers"
  - "Changes the JSON envelope shape — breaking for agent consumers"
-->

## Surfaces touched

<!-- Tick all that apply -->

- [ ] Human TTY output (tables, colors, prompts, progress)
- [ ] Machine output (`--json`, `--ndjson`, `--fields`, `--filter`)
- [ ] Agent surface (`kash docs`, `kash schema`, `kash explain`)
- [ ] Auth / config (`~/.kash/config.json`, env vars, profiles)
- [ ] Direct on-chain (`kash protocol`, `kash eoa`)
- [ ] Tab completion
- [ ] Error catalog / envelope contract
- [ ] Documentation only

## Checklist

- [ ] Typecheck passes (`pnpm typecheck`)
- [ ] Lint passes (`pnpm lint`)
- [ ] Tests pass and cover both happy path AND at least one failure mode (`pnpm test`)
- [ ] CHANGELOG.md updated under `[Unreleased]`
- [ ] If touching the error envelope or any agent surface: contract test (`tests/unit/contracts.test.ts`) updated
- [ ] If adding a subcommand or flag: README + `--help` text updated
- [ ] If adding a subcommand: `omelette` `COMMANDS` map in `src/completion.ts` updated (drift test enforces this)
- [ ] Runtime smoke passes (`pnpm build && node scripts/runtime-smoke.mjs`)
- [ ] No private keys, API keys, or webhook secrets touched anywhere they could be persisted to disk
