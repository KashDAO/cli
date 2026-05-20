---
name: Feature request
about: A new command, flag, output mode, or capability
title: '[feat] '
labels: enhancement
---

## What problem are you solving

<!--
Lead with the problem, not the solution. "I have to chain three
`kash` calls + jq to do X" is more useful than "add a --foo flag".
-->

## Proposed surface

<!--
If you have a specific shape in mind, sketch it. Otherwise leave
this blank and we'll design together.

Example:
  kash markets list --since 2026-01-01 --json
-->

## Audience

- [ ] Humans (interactive shell use)
- [ ] AI agents (`--json --quiet` consumers)
- [ ] Both

## Stability surface

Does this proposal touch any of the SemVer-stable contract surfaces?

- [ ] `CliErrorEnvelopeSchema` (error envelope shape)
- [ ] `VersionManifestSchema` / `CliCapabilitySchema` (capability flags)
- [ ] `CliConfigEnvelopeSchema` (config / auth status shape)
- [ ] `ERROR_CATALOG` (new error codes / actions)
- [ ] None — purely additive

## Anything else

<!-- Workarounds you've tried, alternatives you've considered, related
issues, prior art in other CLIs (stripe, gh, vercel, aws). -->
