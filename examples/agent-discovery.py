#!/usr/bin/env python3
"""
Agent startup pattern: introspect the CLI surface before doing
anything.

Run this once at agent startup to load the command tree, the JSON
schemas for request bodies, and the error catalog into the agent's
context. The agent then plans calls against the structured shape
rather than scraping `--help` text.

Output: a single JSON document the agent can index into. Pipe to
disk or feed straight into the LLM prompt.

Prerequisites:
  - kash CLI on PATH (`npm install -g @kashdao/cli`)
  - No API key needed — uses public introspection commands only.

Run:
  python3 agent-discovery.py > kash-surface.json
"""
from __future__ import annotations

import json
import subprocess
import sys


def kash_json(*args: str) -> object:
    proc = subprocess.run(
        ["kash", *args, "--json", "--quiet"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def main() -> None:
    surface = {
        "version": kash_json("version"),
        "commands": kash_json("docs"),
        "schemas": kash_json("schema"),
        "errors": kash_json("explain"),
    }
    json.dump(surface, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
