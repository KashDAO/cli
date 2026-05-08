#!/usr/bin/env bash
# portfolio-export.sh — stream every position and trade as NDJSON.
#
# Designed for nightly back-office exports. Uses --ndjson so we never
# buffer the full result set in memory — works for accounts with
# tens of thousands of trades.
#
# Output goes to two files in the current directory:
#   trades-<timestamp>.jsonl
#   positions-<timestamp>.json
#
# Prerequisites:
#   - kash CLI on PATH (`npm install -g @kashdao/cli`)
#   - KASH_API_KEY set, or `kash auth set-key` already run
#   - jq on PATH

set -euo pipefail

TS=$(date -u +%Y%m%dT%H%M%SZ)

# Trades — paginated, so we use --ndjson to stream.
echo "Exporting trades..."
kash trade list --all --ndjson > "trades-${TS}.jsonl"
TRADE_COUNT=$(wc -l < "trades-${TS}.jsonl" | tr -d ' ')
echo "  $TRADE_COUNT trades → trades-${TS}.jsonl"

# Positions — single response, so plain --json works.
echo "Exporting positions..."
kash portfolio positions --json --quiet > "positions-${TS}.json"
POSITION_COUNT=$(jq -r '.count' < "positions-${TS}.json")
echo "  $POSITION_COUNT positions → positions-${TS}.json"

# Sanity check: every trade should reference a market we actually
# hold a position in (or recently held). Surface trades that don't.
ORPHAN_COUNT=$(jq -s --slurpfile pos "positions-${TS}.json" '
  reduce .[] as $t (
    [];
    if [$pos[0].data[].marketId] | index($t.marketId) then . else . + [$t.id] end
  ) | length
' "trades-${TS}.jsonl")

if (( ORPHAN_COUNT > 0 )); then
  echo "Note: $ORPHAN_COUNT trades reference markets you no longer hold a position in." >&2
fi
