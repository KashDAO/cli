---
name: Bug report
about: Something the CLI does that it shouldn't, or doesn't do that it should
title: '[bug] '
labels: bug
---

<!--
SECURITY VULNERABILITIES: do NOT file here. Email security@kash.bot.
See SECURITY.md for the disclosure process.
-->

## What happened

<!-- One paragraph: what you ran, what the CLI did, what you expected. -->

## Reproduction

```sh
# Exact command(s). Redact API keys.
kash …
```

## Output

```
# Paste the output. If --json was set, paste the JSON envelope verbatim.
```

## Environment

Paste the output of `kash version --json`:

```json

```

If the bug only reproduces in a specific shell or platform, mention that
here (zsh on macOS 14, bash on Ubuntu 22.04, PowerShell 7 on Windows, etc.).

## requestId / correlationId

If the failing command emitted a `requestId` (server failures) or
`correlationId` (trace flows), paste it here — that lets us pull the
server-side log without you sharing more than you have to.

## Anything else

<!-- Logs, screenshots, frequency, workarounds you've tried. -->
