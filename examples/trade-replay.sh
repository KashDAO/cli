#!/usr/bin/env bash
# trade-replay.sh — safe-retry pattern using a self-generated UUID v4.
#
# We generate the Idempotency-Key UP FRONT (with `uuidgen`) so the
# very first attempt and every retry share the same key. The server
# guarantees the trade is created at most once: a successful retry
# returns the original trade record (`idempotent: true`); a failed
# retry replays cleanly without double-spending.
#
# This is the production-correct pattern. The CLI also offers
# `--auto-idempotency-key`, which is convenient when you don't need
# to retry across process boundaries — but if you might retry from a
# *different* shell or after a crash, generate the key yourself and
# persist it before the first call.
#
# Usage:
#   ./trade-replay.sh <market-id> <outcome> <usdc-amount>
#
# Resume after a crash by exporting the previous IDEM_KEY:
#   IDEM_KEY=<previous-key> ./trade-replay.sh <market-id> <outcome> <amount>
#
# Prerequisites:
#   - kash CLI on PATH (`npm install -g @kashdao/cli`)
#   - KASH_API_KEY set, or `kash auth set-key` already run
#   - jq, uuidgen on PATH

set -euo pipefail

MARKET_ID=${1:?market id required}
OUTCOME=${2:?outcome index required}
AMOUNT=${3:?USDC amount required}
MAX_ATTEMPTS=5

# Generate the Idempotency-Key once. Persist it in case the script is
# killed mid-flight — the operator can re-run with the same key by
# exporting IDEM_KEY before invoking again.
IDEM_KEY=${IDEM_KEY:-$(uuidgen)}
echo "Using Idempotency-Key=$IDEM_KEY" >&2

ATTEMPT=1
while (( ATTEMPT <= MAX_ATTEMPTS )); do
  OUTPUT=$(kash trade buy "$MARKET_ID" \
    --outcome "$OUTCOME" \
    --amount "$AMOUNT" \
    --idempotency-key "$IDEM_KEY" \
    --wait \
    --json \
    --quiet) && rc=0 || rc=$?

  if (( rc == 0 )); then
    echo "$OUTPUT"
    exit 0
  fi

  CODE=$(jq -r '.error.code // "UNEXPECTED"' <<<"$OUTPUT")
  RECOVERABLE=$(jq -r '.error.recoverable // false' <<<"$OUTPUT")
  RETRY_AFTER_MS=$(jq -r '.error.retryAfterMs // 0' <<<"$OUTPUT")

  if [[ "$RECOVERABLE" != "true" ]]; then
    echo "Non-recoverable error [$CODE]; aborting." >&2
    echo "$OUTPUT" >&2
    exit 1
  fi

  # Honor the server's retryAfterMs when present, otherwise back off
  # linearly. Cap at 30s so a misconfigured retryAfterMs can't pin the
  # script forever.
  if (( RETRY_AFTER_MS > 0 )); then
    SLEEP_S=$(( (RETRY_AFTER_MS + 999) / 1000 ))
  else
    SLEEP_S=$(( ATTEMPT * 2 ))
  fi
  if (( SLEEP_S > 30 )); then
    SLEEP_S=30
  fi

  echo "Attempt $ATTEMPT failed [$CODE]; sleeping ${SLEEP_S}s before retry." >&2
  sleep "$SLEEP_S"
  (( ATTEMPT++ )) || true
done

echo "Exhausted $MAX_ATTEMPTS attempts. Idempotency-Key=$IDEM_KEY" >&2
echo "Re-run with IDEM_KEY=$IDEM_KEY $0 $* to continue from this point." >&2
exit 1
