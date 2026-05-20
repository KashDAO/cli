# `kash` — command reference

> **This file is auto-generated** by `scripts/generate-docs.mjs` from the live
> output of `kash docs --json`. Do not hand-edit. Regenerate with `pnpm docs`
> after any command-tree change.

Every command, flag, argument, alias, and default value below is sourced
directly from the built binary, so the doc cannot drift from runtime
behaviour. For machine-readable use, prefer `kash docs --json` itself; this
file is for humans and search-engine indexing.

## Top-level usage

```sh
kash [global flags] <command> [args]
```

### Global flags

| Flag                   | Description                                                                                                                                                        | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `--json`               | emit machine-readable JSON instead of human-formatted output                                                                                                       | `false` |
| `--quiet`              | suppress spinners, progress, informational logs, AND human-mode tables (pair with --json — bare --quiet on a list/get command produces no stdout at all by design) | `false` |
| `--no-color`           | disable ANSI color in human-mode output                                                                                                                            |         |
| `--debug`              | emit SDK request/response/retry/error traces to stderr; pairs with --json for NDJSON traces                                                                        | `false` |
| `-p, --profile <name>` | pick a named profile from ~/.kash/config.json (overrides KASH_PROFILE)                                                                                             |         |
| `--config <path>`      | use an explicit config file path instead of ~/.kash/config.json (overrides KASH_CONFIG)                                                                            |         |
| `--base-url <url>`     | override the API base URL for this invocation only                                                                                                                 |         |
| `--max-retries <n>`    | override the SDK retry budget for this invocation only                                                                                                             |         |
| `--timeout-ms <n>`     | override the SDK request timeout (ms) for this invocation only                                                                                                     |         |
| `--api-version <date>` | pin against a public-API contract date (sent as 'X-Kash-Api-Version: <date>'). Omit to let the server use its canonical default.                                   |         |
| `--fields <list>`      | comma-separated dot-paths to project on JSON output (e.g. id,title,outcomes.label)                                                                                 |         |
| `--filter <expr>`      | boolean predicate on JSON entries (e.g. 'status==ACTIVE && outcomeCount>2')                                                                                        |         |

## Commands

### `kash auth`

Manage local API credentials.

#### `kash auth set-key`

Store an API key in ~/.kash/config.json (mode 0600).

**Arguments**

- `[key]` — API key starting with "kash\_" (omit to read from stdin or prompt)

**Options**

| Flag           | Description                                                                                                                                                                                                                                             | Default |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--from-stdin` | read the key from stdin (preferred for secret-store integration)                                                                                                                                                                                        |         |
| `--activate`   | also switch the active profile to the one being written (default: leave the active profile unchanged — `kash auth set-key --profile staging` updates 'staging' but doesn't make it active; pass --activate or run `kash config use staging` separately) |         |

#### `kash auth status`

Show locally-configured credentials. Does not call the API.

#### `kash auth logout`

Remove the stored API key from ~/.kash/config.json.

### `kash account`

Read-only account surfaces (usage telemetry, etc.).

#### `kash account usage`

Show per-key telemetry summary (24h / 7d / 30d windows).

### `kash markets`

List and inspect prediction markets.

#### `kash markets list`

List markets.

**Options**

| Flag                    | Description                                                                   | Default |
| ----------------------- | ----------------------------------------------------------------------------- | ------- |
| `-s, --status <status>` | filter by status (UNSEEDED \| ACTIVE \| RESOLVED)                             |         |
| `-l, --limit <n>`       | page size (1-100)                                                             | `"20"`  |
| `-c, --cursor <cursor>` | pagination cursor returned by a previous call                                 |         |
| `-a, --all`             | walk every page (use with --json for export)                                  |         |
| `--ndjson`              | stream results as newline-delimited JSON (one record per line); implies --all |         |

#### `kash markets get`

Fetch a single market by id.

**Arguments**

- `<id>` — market UUID

#### `kash markets predictions`

Recent trades against a market (cursor-paginated, newest first).

**Arguments**

- `<marketId>` — market UUID

**Options**

| Flag                    | Description                                                                   | Default |
| ----------------------- | ----------------------------------------------------------------------------- | ------- |
| `-s, --side <side>`     | filter to a single side: buy \| sell                                          |         |
| `-o, --outcome <index>` | filter to a single outcome index (0-based)                                    |         |
| `-l, --limit <n>`       | page size (1-100)                                                             | `"50"`  |
| `-c, --cursor <cursor>` | pagination cursor returned by a previous call                                 |         |
| `-a, --all`             | walk every page (use with --json for export)                                  |         |
| `--ndjson`              | stream results as newline-delimited JSON (one record per line); implies --all |         |

### `kash quote`

Get on-chain AMM price quotes (requires `markets:quote` scope).

#### `kash quote buy`

Quote a buy of USDC into an outcome.

**Arguments**

- `<marketId>` — market UUID

**Options**

| Flag                    | Description                                   | Default |
| ----------------------- | --------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                       |         |
| `-a, --amount <usdc>`   | USDC to spend (decimal, e.g. "10" or "12.50") |         |

#### `kash quote sell`

Quote a sell of outcome tokens back into USDC.

**Arguments**

- `<marketId>` — market UUID

**Options**

| Flag                    | Description                                                                | Default |
| ----------------------- | -------------------------------------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                                                    |         |
| `-t, --tokens <amount>` | outcome tokens to surrender (decimal, e.g. "1.5") — quote-side input shape |         |

### `kash trade`

Place trades and inspect their status.

#### `kash trade buy`

Buy outcome tokens for a market.

**Arguments**

- `<marketId>` — market UUID

**Options**

| Flag                                       | Description                                                                                             | Default |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------- |
| `-o, --outcome <index>`                    | outcome index (0-based)                                                                                 |         |
| `-a, --amount <usdc>`                      | USDC amount as a decimal (max 6 fractional digits)                                                      |         |
| `--wait`                                   | block until the trade reaches a terminal state                                                          |         |
| `--wait-timeout-ms, --timeout <ms>`        | wait timeout in milliseconds (default 60000) — distinct from the global --timeout-ms (per-HTTP-request) |         |
| `--poll-interval-ms, --poll-interval <ms>` | wait poll interval in milliseconds (default 2000)                                                       |         |
| `--idempotency-key <key>`                  | sets the Idempotency-Key HTTP header                                                                    |         |
| `--auto-idempotency-key`                   | auto-generate an Idempotency-Key (UUID v4) and surface it in the response                               |         |
| `--client-request-id <id>`                 | sets the body-level clientRequestId for replay safety                                                   |         |
| `--dry-run`                                | preview the request without sending — emits the would-be body and resolved headers                      |         |

#### `kash trade sell`

Sell outcome tokens back to the market (Kash-orchestrated / hosted-API flow).

**Arguments**

- `<marketId>` — market UUID

**Options**

| Flag                                       | Description                                                                                                                                                               | Default |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-o, --outcome <index>`                    | outcome index (0-based)                                                                                                                                                   |         |
| `-a, --amount <usdc>`                      | target USDC to receive (decimal, max 6 fractional digits) — NOT tokens-in. Use `kash quote sell --tokens <n>` if you have a tokens-in figure and want a USDC quote first. |         |
| `--wait`                                   | block until the trade reaches a terminal state                                                                                                                            |         |
| `--wait-timeout-ms, --timeout <ms>`        | wait timeout in milliseconds (default 60000) — distinct from the global --timeout-ms (per-HTTP-request)                                                                   |         |
| `--poll-interval-ms, --poll-interval <ms>` | wait poll interval in milliseconds (default 2000)                                                                                                                         |         |
| `--idempotency-key <key>`                  | sets the Idempotency-Key HTTP header                                                                                                                                      |         |
| `--auto-idempotency-key`                   | auto-generate an Idempotency-Key (UUID v4) and surface it in the response                                                                                                 |         |
| `--client-request-id <id>`                 | sets the body-level clientRequestId for replay safety                                                                                                                     |         |
| `--dry-run`                                | preview the request without sending — emits the would-be body and resolved headers                                                                                        |         |

#### `kash trade status`

Show the status of a trade. Use --poll to block until terminal.

**Arguments**

- `<id>` — trade UUID

**Options**

| Flag                                       | Description                                                                                             | Default |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------- |
| `--poll`                                   | poll until the trade reaches a terminal state                                                           |         |
| `--wait-timeout-ms, --timeout <ms>`        | poll timeout in milliseconds (default 60000) — distinct from the global --timeout-ms (per-HTTP-request) |         |
| `--poll-interval-ms, --poll-interval <ms>` | poll interval in milliseconds (default 2000)                                                            |         |

#### `kash trade list`

List your trades.

**Options**

| Flag                       | Description                                                                                                      | Default |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------- |
| `-s, --status <status...>` | status filter; repeat or comma-separate (e.g. --status pending --status executing \| --status pending,executing) |         |
| `-m, --market <id>`        | filter by market id                                                                                              |         |
| `-l, --limit <n>`          | page size (1-100)                                                                                                | `"20"`  |
| `-c, --cursor <cursor>`    | pagination cursor                                                                                                |         |
| `-a, --all`                | walk every page (use with --json for export)                                                                     |         |
| `--ndjson`                 | stream results as newline-delimited JSON (one record per line); implies --all                                    |         |

#### `kash trade confirm`

Confirm a high-value trade using its one-time token.

**Arguments**

- `<id>` — trade UUID
- `[token]` — confirmation token (omit to read from stdin or prompt)

**Options**

| Flag            | Description                            | Default |
| --------------- | -------------------------------------- | ------- |
| `--token-stdin` | read the confirmation token from stdin |         |

### `kash portfolio`

View your portfolio.

#### `kash portfolio show`

Show the aggregate portfolio summary.

#### `kash portfolio positions`

List active positions.

**Options**

| Flag                | Description         | Default |
| ------------------- | ------------------- | ------- |
| `-m, --market <id>` | filter by market id |         |

### `kash protocol`

Self-orchestrated direct-to-chain operations (uses @kashdao/protocol-sdk). Like the default Kash-orchestrated mode, this path is non-custodial — the difference is who builds and submits trades.

#### `kash protocol balance`

Read on-chain USDC + gas balance for a smart account (defaults to the profile's).

**Arguments**

- `[account]` — smart-account address (defaults to the active profile's smartAccount)

#### `kash protocol market`

Read on-chain market state (reserves, supplies, weights, derived probabilities).

**Arguments**

- `<address>` — market contract address (0x-prefixed)

#### `kash protocol quote`

On-chain price quote for buying or selling an outcome.

**Arguments**

- `<address>` — market contract address (0x-prefixed)

**Options**

| Flag                     | Description                                                                           | Default                 |
| ------------------------ | ------------------------------------------------------------------------------------- | ----------------------- | --- |
| `-s, --side <buy         | sell>`                                                                                | trade side: buy or sell |     |
| `-o, --outcome <index>`  | outcome index (0-based)                                                               |                         |
| `-a, --amount <decimal>` | amount: USDC decimal for buy (e.g. "10"), outcome-token decimal for sell (e.g. "1.5") |                         |

#### `kash protocol position`

Read on-chain outcome-token holdings (ERC-1155) for a market.

**Arguments**

- `<market>` — market contract address (0x-prefixed)
- `[account]` — EOA or smart-account address whose holdings to read (default: profile's smartAccount)

#### `kash protocol allowance`

Read the on-chain USDC allowance from `account` to `spender`.

**Arguments**

- `<spender>` — spender contract address (e.g. a market) — 0x-prefixed
- `[account]` — owner address (default: profile's smartAccount)

#### `kash protocol smart-account`

Smart-account address derivation and deployment-status checks.

##### `kash protocol smart-account compute`

Derive the deterministic smart-account address for an EOA owner.

**Options**

| Flag                    | Description                                         | Default |
| ----------------------- | --------------------------------------------------- | ------- |
| `-o, --owner <address>` | EOA owner address (0x-prefixed)                     |         |
| `-s, --salt <n>`        | optional salt as a non-negative integer (default 0) | `"0"`   |

##### `kash protocol smart-account is-deployed`

Check whether a smart account has bytecode (i.e. has been deployed on-chain).

**Arguments**

- `[address]` — smart account address (default: profile's smartAccount)

#### `kash protocol fees`

EIP-1559 fee estimate for the configured chain (uses eth_feeHistory).

**Options**

| Flag                        | Description                                                                                   | Default |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `--blocks <n>`              | number of recent blocks to sample (default 4)                                                 |         |
| `--percentile <n>`          | priority-fee percentile to take from each sampled block (1-99, default 50)                    |         |
| `--base-multiplier <n>`     | multiplier applied to predicted next-block base fee (default 2.0; raise for congested chains) |         |
| `--priority-floor-gwei <n>` | floor for maxPriorityFeePerGas in gwei (default 1)                                            |         |

#### `kash protocol token-id`

Compute the ERC-1155 token id for a (marketId, outcomeIndex) pair (offline; no RPC).

**Options**

| Flag                       | Description                                             | Default |
| -------------------------- | ------------------------------------------------------- | ------- |
| `-m, --market-id <bigint>` | on-chain numeric market id (decimal or 0x-prefixed hex) |         |
| `-o, --outcome <index>`    | outcome index (0-255)                                   |         |

#### `kash protocol decode-revert`

Decode raw revert data into (name, args) using the Market + EntryPoint ABIs.

**Arguments**

- `<data>` — raw revert data (0x-prefixed hex)

#### `kash protocol trade`

Direct-mode trade execution (UserOp signed locally, submitted via bundler).

##### `kash protocol trade buy`

One-shot BUY: prepare → simulate → sign → submit (and wait by default).

**Arguments**

- `<market>` — market contract address (0x-prefixed)

**Options**

| Flag                     | Description                                                      | Default |
| ------------------------ | ---------------------------------------------------------------- | ------- |
| `-o, --outcome <index>`  | outcome index (0-based)                                          |         |
| `-a, --amount <usdc>`    | USDC to spend (decimal — e.g. "10" or "12.50")                   |         |
| `--slippage-bps <n>`     | slippage tolerance in basis points (default 50 = 0.5%)           |         |
| `--deadline-sec <n>`     | unix-seconds deadline (default now + 5min)                       |         |
| `--dry-run`              | prepare + simulate but DO NOT sign or submit; print the UserOp   |         |
| `--no-simulate`          | skip the eth_call preflight (faster, riskier)                    |         |
| `--no-wait`              | fire-and-forget: return userOpHash without waiting for inclusion |         |
| `--wait-timeout-ms <n>`  | cap on the receipt wait (default 60000)                          |         |
| `--wait-interval-ms <n>` | receipt poll interval (default 1500)                             |         |

##### `kash protocol trade sell`

One-shot SELL: prepare → simulate → sign → submit (and wait by default).

**Arguments**

- `<market>` — market contract address (0x-prefixed)

**Options**

| Flag                     | Description                                                      | Default |
| ------------------------ | ---------------------------------------------------------------- | ------- |
| `-o, --outcome <index>`  | outcome index (0-based)                                          |         |
| `-t, --tokens <amount>`  | outcome tokens to sell (decimal — WAD precision)                 |         |
| `--slippage-bps <n>`     | slippage tolerance in basis points (default 50 = 0.5%)           |         |
| `--deadline-sec <n>`     | unix-seconds deadline (default now + 5min)                       |         |
| `--dry-run`              | prepare + simulate but DO NOT sign or submit; print the UserOp   |         |
| `--no-simulate`          | skip the eth_call preflight (faster, riskier)                    |         |
| `--no-wait`              | fire-and-forget: return userOpHash without waiting for inclusion |         |
| `--wait-timeout-ms <n>`  | cap on the receipt wait (default 60000)                          |         |
| `--wait-interval-ms <n>` | receipt poll interval (default 1500)                             |         |

##### `kash protocol trade close`

Sell the entire SA balance for an outcome (one-shot prepare → submit).

**Arguments**

- `<market>` — market contract address (0x-prefixed)

**Options**

| Flag                     | Description                                                      | Default |
| ------------------------ | ---------------------------------------------------------------- | ------- |
| `-o, --outcome <index>`  | outcome index (0-based)                                          |         |
| `--slippage-bps <n>`     | slippage tolerance in basis points (default 50 = 0.5%)           |         |
| `--deadline-sec <n>`     | unix-seconds deadline (default now + 5min)                       |         |
| `--dry-run`              | prepare + simulate but DO NOT sign or submit; print the UserOp   |         |
| `--no-simulate`          | skip the eth_call preflight (faster, riskier)                    |         |
| `--no-wait`              | fire-and-forget: return userOpHash without waiting for inclusion |         |
| `--wait-timeout-ms <n>`  | cap on the receipt wait (default 60000)                          |         |
| `--wait-interval-ms <n>` | receipt poll interval (default 1500)                             |         |

##### `kash protocol trade approve`

USDC approval — required once before the first BUY.

**Arguments**

- `<spender>` — spender contract address (typically a Market) — 0x-prefixed

**Options**

| Flag                     | Description                                                                 | Default |
| ------------------------ | --------------------------------------------------------------------------- | ------- |
| `-a, --amount <usdc>`    | atomic-USDC amount to approve (decimal); default is unlimited (MAX_UINT256) |         |
| `--dry-run`              | prepare + simulate but DO NOT sign or submit; print the UserOp              |         |
| `--no-simulate`          | skip the eth_call preflight (faster, riskier)                               |         |
| `--no-wait`              | fire-and-forget: return userOpHash without waiting for inclusion            |         |
| `--wait-timeout-ms <n>`  | cap on the receipt wait (default 60000)                                     |         |
| `--wait-interval-ms <n>` | receipt poll interval (default 1500)                                        |         |

#### `kash protocol userop`

Granular UserOp lifecycle: build, simulate, submit, hash, receipt, wait.

##### `kash protocol userop build`

Build (prepare) a fully-populated unsigned UserOp ready for offline signing.

###### `kash protocol userop build buy`

Build a fully-populated unsigned BUY UserOp ready for offline signing.

**Arguments**

- `<market>` — market contract address (0x-prefixed)

**Options**

| Flag                    | Description                                          | Default |
| ----------------------- | ---------------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                              |         |
| `-a, --amount <usdc>`   | USDC to spend (decimal)                              |         |
| `--slippage-bps <n>`    | slippage tolerance in bps (default 50 = 0.5%)        |         |
| `--deadline-sec <n>`    | unix-seconds deadline (default now + 5min)           |         |
| `--out <path>`          | write the UserOp envelope to a file (default stdout) |         |
| `--no-simulate`         | skip eth_call preflight in `prepare`                 |         |

###### `kash protocol userop build sell`

Build a fully-populated unsigned SELL UserOp ready for offline signing.

**Arguments**

- `<market>` — market contract address (0x-prefixed)

**Options**

| Flag                    | Description                                          | Default |
| ----------------------- | ---------------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                              |         |
| `-t, --tokens <amount>` | outcome tokens to sell (WAD decimal)                 |         |
| `--slippage-bps <n>`    | slippage tolerance in bps (default 50 = 0.5%)        |         |
| `--deadline-sec <n>`    | unix-seconds deadline (default now + 5min)           |         |
| `--out <path>`          | write the UserOp envelope to a file (default stdout) |         |
| `--no-simulate`         | skip eth_call preflight in `prepare`                 |         |

###### `kash protocol userop build close`

Build a fully-populated unsigned UserOp that closes a position (full balance).

**Arguments**

- `<market>` — market contract address (0x-prefixed)

**Options**

| Flag                    | Description                                          | Default |
| ----------------------- | ---------------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                              |         |
| `--slippage-bps <n>`    | slippage tolerance in bps (default 50 = 0.5%)        |         |
| `--deadline-sec <n>`    | unix-seconds deadline (default now + 5min)           |         |
| `--out <path>`          | write the UserOp envelope to a file (default stdout) |         |
| `--no-simulate`         | skip eth_call preflight in `prepare`                 |         |

###### `kash protocol userop build approve`

Build a fully-populated unsigned approve UserOp ready for offline signing.

**Arguments**

- `<spender>` — spender contract address (typically a Market) — 0x-prefixed

**Options**

| Flag                  | Description                                                   | Default |
| --------------------- | ------------------------------------------------------------- | ------- |
| `-a, --amount <usdc>` | atomic-USDC amount (decimal); default unlimited (MAX_UINT256) |         |
| `--out <path>`        | write the UserOp envelope to a file (default stdout)          |         |
| `--no-simulate`       | skip eth_call preflight in `prepare`                          |         |

##### `kash protocol userop simulate`

Simulate (eth_call) an UnsignedUserOp from a file or stdin.

**Arguments**

- `[file]` — path to a UserOp JSON file (omit or pass "-" for stdin)

##### `kash protocol userop submit`

Submit a SignedUserOp from a file or stdin to the configured bundler.

**Arguments**

- `[file]` — path to a SignedUserOp JSON file (omit or pass "-" for stdin)

**Options**

| Flag                     | Description                                                 | Default |
| ------------------------ | ----------------------------------------------------------- | ------- |
| `--skip-staleness-check` | bypass the EIP-191 staleness check (for typed-data signers) |         |
| `--wait`                 | wait for receipt after submitting                           |         |
| `--wait-timeout-ms <n>`  | cap on the receipt wait (default 60000)                     |         |
| `--wait-interval-ms <n>` | receipt poll interval (default 1500)                        |         |

##### `kash protocol userop hash`

Recompute the canonical EIP-4337 v0.7 hash for a UnsignedUserOp.

**Arguments**

- `[file]` — path to a UserOp JSON file (omit or pass "-" for stdin)

##### `kash protocol userop receipt`

Fetch the bundler receipt for a UserOp hash (null if not yet included).

**Arguments**

- `<hash>` — UserOp hash (0x-prefixed, 32 bytes)

##### `kash protocol userop wait`

Wait for a UserOp to be included; polls with exponential backoff.

**Arguments**

- `<hash>` — UserOp hash (0x-prefixed, 32 bytes)

**Options**

| Flag                                  | Description                                                                                               | Default |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| `--wait-timeout-ms, --timeout-ms <n>` | total time budget across polls (default 60000) — distinct from the global --timeout-ms (per-HTTP-request) |         |
| `--interval-ms <n>`                   | poll interval (default 1500)                                                                              |         |

#### `kash protocol watch`

Subscribe to on-chain trade events for a market (NDJSON stream).

**Arguments**

- `<market>` — market contract address (0x-prefixed)

**Options**

| Flag               | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `--max-events <n>` | exit cleanly after observing N events          |         |
| `--timeout-ms <n>` | exit cleanly after this wall-clock budget (ms) |         |

### `kash eoa`

Self-orchestrated direct-to-chain operations using a vanilla EOA (no smart account). Like every Kash entry point, this path is non-custodial.

#### `kash eoa balance`

Read on-chain USDC + native gas balances for the EOA (defaults to signer's address).

**Arguments**

- `[account]` — address to read (default: signer's ownerAddress)

#### `kash eoa market`

Read on-chain market state (reserves, supplies, weights, derived probabilities).

**Arguments**

- `<address>` — market contract address (0x-prefixed)

#### `kash eoa quote`

On-chain price quote for buying or selling an outcome.

**Arguments**

- `<address>` — market contract address

**Options**

| Flag                     | Description                            | Default |
| ------------------------ | -------------------------------------- | ------- |
| `-s, --side <side>`      | buy \| sell                            |         |
| `-o, --outcome <index>`  | outcome index (0-based)                |         |
| `-a, --amount <decimal>` | USDC for buy / outcome tokens for sell |         |

#### `kash eoa position`

Read on-chain outcome-token holdings (ERC-1155) for a market.

**Arguments**

- `<market>` — market contract address (0x-prefixed)
- `[account]` — address whose holdings to read (default: signer's)

#### `kash eoa allowance`

Read the on-chain USDC allowance from `account` to `spender`.

**Arguments**

- `<spender>` — spender contract address
- `[account]` — owner address (default: signer's)

#### `kash eoa fees`

EIP-1559 fee estimate for the configured chain.

**Options**

| Flag                        | Description                                               | Default |
| --------------------------- | --------------------------------------------------------- | ------- |
| `--blocks <n>`              | number of recent blocks to sample (default 4)             |         |
| `--percentile <n>`          | priority-fee percentile per block (1-99, default 50)      |         |
| `--base-multiplier <n>`     | multiplier on predicted next-block base fee (default 2.0) |         |
| `--priority-floor-gwei <n>` | floor for maxPriorityFeePerGas in gwei (default 1)        |         |

#### `kash eoa trade`

Direct-mode trade execution (vanilla EIP-1559 tx, signed locally).

##### `kash eoa trade buy`

One-shot BUY (EIP-1559 tx, signed locally and submitted to chain).

**Arguments**

- `<market>` — market contract address

**Options**

| Flag                    | Description                                                   | Default |
| ----------------------- | ------------------------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                                       |         |
| `-a, --amount <usdc>`   | USDC to spend (decimal)                                       |         |
| `--slippage-bps <n>`    | slippage tolerance in bps (default 50)                        |         |
| `--deadline-sec <n>`    | unix-seconds deadline (default now + 5min)                    |         |
| `--dry-run`             | prepare + simulate but DO NOT sign or submit                  |         |
| `--no-simulate`         | skip eth_call preflight                                       |         |
| `--no-wait`             | fire-and-forget: return tx hash without waiting for inclusion |         |
| `--wait-timeout-ms <n>` | cap on the receipt wait (default 60000)                       |         |

##### `kash eoa trade sell`

One-shot SELL.

**Arguments**

- `<market>` — market contract address

**Options**

| Flag                    | Description                                  | Default |
| ----------------------- | -------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                      |         |
| `-t, --tokens <amount>` | outcome tokens to sell (WAD decimal)         |         |
| `--slippage-bps <n>`    | slippage tolerance in bps (default 50)       |         |
| `--deadline-sec <n>`    | unix-seconds deadline (default now + 5min)   |         |
| `--dry-run`             | prepare + simulate but DO NOT sign or submit |         |
| `--no-simulate`         | skip eth_call preflight                      |         |
| `--no-wait`             | fire-and-forget                              |         |
| `--wait-timeout-ms <n>` | cap on the receipt wait (default 60000)      |         |

##### `kash eoa trade close`

Sell the entire EOA balance for an outcome.

**Arguments**

- `<market>` — market contract address

**Options**

| Flag                    | Description                                  | Default |
| ----------------------- | -------------------------------------------- | ------- |
| `-o, --outcome <index>` | outcome index (0-based)                      |         |
| `--slippage-bps <n>`    | slippage tolerance in bps (default 50)       |         |
| `--deadline-sec <n>`    | unix-seconds deadline (default now + 5min)   |         |
| `--dry-run`             | prepare + simulate but DO NOT sign or submit |         |
| `--no-simulate`         | skip eth_call preflight                      |         |
| `--no-wait`             | fire-and-forget                              |         |
| `--wait-timeout-ms <n>` | cap on the receipt wait (default 60000)      |         |

##### `kash eoa trade approve`

USDC approval — required once before the first BUY.

**Arguments**

- `<spender>` — spender contract address (typically a Market)

**Options**

| Flag                    | Description                                  | Default |
| ----------------------- | -------------------------------------------- | ------- |
| `-a, --amount <usdc>`   | atomic-USDC amount (default unlimited)       |         |
| `--dry-run`             | prepare + simulate but DO NOT sign or submit |         |
| `--no-simulate`         | skip eth_call preflight                      |         |
| `--no-wait`             | fire-and-forget                              |         |
| `--wait-timeout-ms <n>` | cap on the receipt wait (default 60000)      |         |

### `kash webhooks`

Manage webhook delivery, signing secrets, and signature verification.

#### `kash webhooks list`

List recent webhook delivery events for the calling key.

**Options**

| Flag                    | Description                                                                                             | Default |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| `-l, --limit <n>`       | page size (1-100)                                                                                       | `"20"`  |
| `-c, --cursor <cursor>` | opaque cursor from a previous response                                                                  |         |
| `-a, --all`             | walk every page (subject to --limit per page)                                                           | `false` |
| `--ndjson`              | stream results as newline-delimited JSON (one record per line); implies --all                           |         |
| `--status <status...>`  | filter by derived status (one of: none, pending, delivered, retrying, failed); repeat or comma-separate |         |

#### `kash webhooks rotate-secret`

Rotate the webhook signing secret for the current API key.

**Options**

| Flag        | Description                                                     | Default |
| ----------- | --------------------------------------------------------------- | ------- |
| `-y, --yes` | skip the interactive confirmation (required for --json --quiet) |         |

#### `kash webhooks redeliver`

Re-queue a webhook event for delivery.

**Arguments**

- `<eventId>` — webhook event UUID

#### `kash webhooks verify`

Verify a captured X-Kash-Signature against the raw body and secret.

**Options**

| Flag                       | Description                                                          | Default |
| -------------------------- | -------------------------------------------------------------------- | ------- |
| `-s, --signature <header>` | the X-Kash-Signature header value (e.g. "t=…,v1=…")                  |         |
| `--body <string>`          | raw request body as a string (use --body-file for binary-safe input) |         |
| `--body-file <path>`       | path to a file containing the raw request body                       |         |
| `--secret <value>`         | webhook signing secret (overrides KASH_WEBHOOK_SECRET)               |         |
| `--secret-file <path>`     | read secret from a file (preferred over --secret on shared shells)   |         |
| `--tolerance-ms <n>`       | replay-window tolerance in milliseconds (default 300000 = 5 minutes) |         |

#### `kash webhooks replay`

Re-sign a captured webhook payload and POST it to a target URL.

**Arguments**

- `[body]` — path to a JSON body file (omit or pass "-" for stdin)

**Options**

| Flag                         | Description                                                                                                    | Default |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| `-t, --target <url>`         | destination URL (e.g. ngrok tunnel or localhost endpoint)                                                      |         |
| `-s, --secret <secret>`      | webhook signing secret (overrides KASH_WEBHOOK_SECRET)                                                         |         |
| `--secret-file <path>`       | read the signing secret from a file (preferred — keeps the value out of argv and env)                          |         |
| `--secret-env <name>`        | read the signing secret from this environment variable (default: KASH_WEBHOOK_SECRET)                          |         |
| `--timestamp-ms <ms>`        | unix-ms timestamp for the signature header (default: current time)                                             |         |
| `--signature-header <name>`  | override the signature header name (default: X-Kash-Signature)                                                 |         |
| `--timeout-ms <ms>`          | fetch timeout (default 10000)                                                                                  |         |
| `--dry-run`                  | compute the signature header and inspect the would-be POST without sending it                                  |         |
| `--refuse-private-addresses` | hard-fail (instead of warning) when --target is a loopback / private / link-local address — recommended for CI |         |

### `kash config`

Inspect and edit ~/.kash/config.json (multi-profile).

#### `kash config show`

Print the resolved CLI configuration.

#### `kash config set`

Set a single config field.

**Arguments**

- `<key>` — top-level key OR `customChain.<leaf>` / `customChain.smartAccount.<leaf>` dot-path
- `<value>` — value to set

#### `kash config profiles`

List configured profiles in the config file.

#### `kash config use`

Switch the active profile (writes currentProfile to the config file).

**Arguments**

- `<profile>` — profile name

**Options**

| Flag          | Description                                                                                                                      | Default |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--allow-new` | permit switching to a profile that does not yet exist (you must populate it via `kash auth set-key --profile <name>` afterwards) |         |

#### `kash config remove`

Delete a named profile from the config file.

**Arguments**

- `<profile>` — profile name to remove

#### `kash config reset`

Delete ~/.kash/config.json.

**Options**

| Flag        | Description                       | Default |
| ----------- | --------------------------------- | ------- |
| `-y, --yes` | skip the interactive confirmation |         |

#### `kash config export`

Dump the entire multi-profile config (API keys redacted by default).

**Options**

| Flag                | Description                                          | Default |
| ------------------- | ---------------------------------------------------- | ------- |
| `-o, --out <path>`  | write to a file instead of stdout (mode 0600)        |         |
| `--include-secrets` | include raw API keys in the export (round-trippable) |         |

#### `kash config import`

Merge a `kash config export` bundle into the local config (mode 0600).

**Arguments**

- `[file]` — path to a JSON bundle (omit to read from stdin)

**Options**

| Flag             | Description                                     | Default |
| ---------------- | ----------------------------------------------- | ------- |
| `--no-overwrite` | skip profiles whose name already exists locally |         |
| `--dry-run`      | preview the merge without writing to disk       |         |

### `kash health`

Check connectivity to the Kash API. Exits 1 when not ok. Honors --timeout-ms (default 5000).

### `kash version`

Show CLI version and runtime environment.

**Options**

| Flag      | Description                                                 | Default |
| --------- | ----------------------------------------------------------- | ------- |
| `--check` | probe npm for a newer @kashdao/cli release (cached for 24h) |         |

### `kash explain`

Look up one or more error codes and their recommended recovery steps.

**Arguments**

- `[codes] …` — error codes to explain (omit to list every known code)

### `kash schema`

Emit JSON Schema for the SDK request/response shapes.

**Arguments**

- `[name]` — optional schema name; omit to list every available schema (one of: CliConfigEnvelope, CliErrorAction, CliErrorEnvelope, ConfirmTradeBody, ConfirmTradeResponse, CreateTradeAcceptedResponse, CreateTradeBody, GetMarketResponse, GetTraceResponse, GetTradeResponse, HealthResult, ListMarketsResponse, ListTradesResponse, ListWebhookEventsResponse, MarketResource, Pagination, PortfolioSummary, PositionResource, PositionsResponse, ProblemDetails, ProtocolBalanceEnvelope, ProtocolMarketEnvelope, ProtocolQuoteEnvelope, QuoteBuyDetail, QuoteMarketSummary, QuoteResponse, QuoteSellDetail, RedeliverWebhookEvent, RedeliverWebhookResponse, RotateWebhookSecretResponse, TraceEvent, TraceEventData, TraceResource, TradeDryRunEnvelope, TradeResource, VersionManifest, WebhookEventResource)

**Options**

| Flag     | Description                                                                                                          | Default |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| `--list` | emit only the schema names (cheap probe: skips the zod-to-json-schema conversion that the full --json catalog needs) |         |

### `kash setup`

Interactive first-run wizard: configure an API key, verify, install completion.

**Options**

| Flag              | Description                                                     | Default |
| ----------------- | --------------------------------------------------------------- | ------- |
| `-y, --yes`       | accept all defaults and skip optional prompts (non-interactive) |         |
| `--api-key <key>` | pass the API key non-interactively (skips the prompt)           |         |

### `kash trace`

Fetch the curated event timeline for a trade's correlation id.

**Arguments**

- `<correlationId>` — correlation UUID — see `kash trade status <id> --json | jq -r .correlationId`

### `kash with-retry`

Re-run a kash command on recoverable failures (rate limits, transient errors).

**Arguments**

- `<command> …` — kash command + args; pass after `--` to disambiguate

**Options**

| Flag                     | Description                                                                                                                                                            | Default   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `--max-attempts <n>`     | maximum total attempts including the first (default 5)                                                                                                                 | `"5"`     |
| `--initial-delay-ms <n>` | starting backoff when the envelope has no retryAfterMs (default 1000)                                                                                                  | `"1000"`  |
| `--max-delay-ms <n>`     | cap on the per-attempt wait (default 30000)                                                                                                                            | `"30000"` |
| `--retry-without-json`   | retry even when the inner command did not emit --json (no envelope to discriminate terminal from transient — opt in if you trust the inner command failed transiently) |           |

### `kash docs`

Emit the full command tree as JSON (or summary in human mode).

### `kash completion`

Shell tab-completion utilities.

#### `kash completion install`

Install bash/zsh/fish completion to your shell config.

#### `kash completion uninstall`

Remove kash completions from your shell config.
