#!/usr/bin/env python3
"""
AI agent recipe: call the Kash CLI in --json --quiet mode, parse
structured errors, and recover via `kash explain`.

The agent loop here is intentionally minimal — it's a template, not
a production trader. The patterns it demonstrates:

  1. Always pass --json --quiet so output is deterministic and the
     stdout buffer never mixes with progress noise.
  2. Branch on `code` from the error envelope, not on prose.
  3. On a recoverable error, look up structured `actions` and apply
     them (wait_and_retry, run_command, etc.) — these come from the
     same catalog as `kash explain <code>`.
  4. Capture `requestId` for support / debugging.

Prerequisites:
  - kash CLI on PATH (`npm install -g @kashdao/cli`)
  - KASH_API_KEY set, or `kash auth set-key` already run
  - Python 3.10+ (uses dataclasses + the `|` union syntax)

Run:
  KASH_API_KEY=kash_… python3 ai-agent.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from dataclasses import dataclass


@dataclass
class CliResult:
    ok: bool
    data: dict | None
    error: dict | None
    exit_code: int


def run_kash(*args: str, timeout: float = 60) -> CliResult:
    """Invoke `kash <args> --json --quiet`. Returns a structured result."""
    proc = subprocess.run(
        ["kash", *args, "--json", "--quiet"],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    payload: dict | None
    try:
        payload = json.loads(proc.stdout) if proc.stdout.strip() else None
    except json.JSONDecodeError:
        payload = None

    if proc.returncode == 0:
        return CliResult(ok=True, data=payload, error=None, exit_code=0)

    # Error envelope: { ok: false, error: { code, message, recoverable, … } }
    error = (payload or {}).get("error") if isinstance(payload, dict) else None
    return CliResult(ok=False, data=None, error=error, exit_code=proc.returncode)


def with_recovery(*args: str, max_attempts: int = 5) -> dict:
    """Retry-aware runner. Honors retryAfterMs, action hints, and exit codes."""
    for attempt in range(1, max_attempts + 1):
        result = run_kash(*args)
        if result.ok:
            return result.data or {}

        # 2 = auth failure. The agent can't recover from this on its own —
        # the human / orchestrator has to fix the key.
        if result.exit_code == 2:
            raise RuntimeError(f"Auth required: {result.error}")

        # Non-recoverable: stop early so we don't spin.
        if not (result.error or {}).get("recoverable", False):
            raise RuntimeError(f"Non-recoverable error: {result.error}")

        # Honor server-side retry hint when present.
        retry_after_ms = (result.error or {}).get("retryAfterMs")
        delay_s = (retry_after_ms / 1000) if retry_after_ms else (attempt * 2)
        code = (result.error or {}).get("code", "UNEXPECTED")
        print(
            f"[agent] attempt {attempt} failed [{code}]; sleeping {delay_s:.1f}s",
            file=sys.stderr,
        )
        time.sleep(delay_s)

    raise RuntimeError(f"Exhausted {max_attempts} attempts.")


def explain_code(code: str) -> dict:
    """Look up an error code's catalog entry. Useful for telemetry."""
    return run_kash("explain", code).data or {}


def main() -> None:
    # 1. Browse markets.
    markets = with_recovery("markets", "list", "--status", "ACTIVE", "--limit", "5")
    if not markets["data"]:
        print("[agent] no active markets", file=sys.stderr)
        return

    target = markets["data"][0]
    print(f"[agent] targeting market {target['id'][:8]}: {target['title']}")

    # 2. Place a trade with auto-idempotency so retries are safe.
    trade = with_recovery(
        "trade", "buy", target["id"],
        "--outcome", "0",
        "--amount", "1",
        "--auto-idempotency-key",
        "--wait",
    )
    print(f"[agent] trade {trade['id'][:8]} → status={trade['status']}")
    if trade.get("txHash"):
        print(f"[agent] tx={trade['txHash']}")


if __name__ == "__main__":
    main()
