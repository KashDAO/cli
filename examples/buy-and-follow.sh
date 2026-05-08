#!/usr/bin/env bash
# buy-and-follow.sh — place a trade and block on settlement.
#
# Usage:
#   ./buy-and-follow.sh <market-id> <outcome> <usdc-amount>
#
# Requires: kash CLI on PATH, KASH_API_KEY set or `kash auth set-key`
# already run, jq.

set -euo pipefail

MARKET_ID=${1:?market id required}
OUTCOME=${2:?outcome index (0-based) required}
AMOUNT=${3:?USDC amount required}

# Use --quiet to suppress spinners; --json gives us a parseable
# envelope; --wait blocks until the trade reaches a terminal state.
RESPONSE=$(kash trade buy "$MARKET_ID" \
  --outcome "$OUTCOME" \
  --amount "$AMOUNT" \
  --wait \
  --json \
  --quiet)

STATUS=$(jq -r '.status' <<<"$RESPONSE")
TX_HASH=$(jq -r '.txHash // empty' <<<"$RESPONSE")
TRADE_ID=$(jq -r '.id' <<<"$RESPONSE")

case "$STATUS" in
  completed)
    echo "Trade $TRADE_ID completed: $TX_HASH"
    ;;
  failed|rejected)
    ERROR=$(jq -r '.errorMessage // .errorCode // "unknown"' <<<"$RESPONSE")
    echo "Trade $TRADE_ID $STATUS: $ERROR" >&2
    exit 1
    ;;
  *)
    echo "Unexpected terminal status: $STATUS" >&2
    echo "$RESPONSE" >&2
    exit 1
    ;;
esac
