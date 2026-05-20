# `@kashdao/cli` examples

Copy-pastable recipes for the most common CLI workflows. Every
example assumes the binary is installed (`npm install -g
@kashdao/cli`) and an API key is configured (`kash auth set-key
<key>` or `KASH_API_KEY=...`).

| File                                           | Audience              | Demonstrates                                                                                      |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| [`buy-and-follow.sh`](./buy-and-follow.sh)     | Bash scripts, CI      | Place a trade, block on settlement with `--wait`, parse the tx hash from `--json --quiet` output. |
| [`trade-replay.sh`](./trade-replay.sh)         | Reliability engineers | Use `--auto-idempotency-key` for safe retries; capture and reuse the generated key on failure.    |
| [`portfolio-export.sh`](./portfolio-export.sh) | Data ops, accountants | Stream all positions and trades as NDJSON; pipe through `jq` for filtering.                       |
| [`webhook-receiver.ts`](./webhook-receiver.ts) | Backend engineers     | Minimal Fastify receiver verifying `X-Kash-Signature` with the SDK's `verifySignature`.           |
| [`ai-agent.py`](./ai-agent.py)                 | LLM/agent engineers   | Python loop that calls `kash --json --quiet`, recovers from errors via `kash explain`.            |
| [`agent-discovery.py`](./agent-discovery.py)   | LLM/agent engineers   | Use `kash docs --json` and `kash schema` to teach an agent the CLI surface at startup.            |

## Running

The shell examples are POSIX-flavored — bash 4+ recommended.
They source `KASH_API_KEY` from your environment; export it before
running, or run inside a shell where `kash auth set-key` was already
called.

The Python and TypeScript examples have their own dependency notes
inline.
