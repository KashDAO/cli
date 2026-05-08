#!/usr/bin/env sh
#
# Kash CLI one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/KashDAO/cli/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/KashDAO/cli/main/scripts/install.sh | sh -s -- --version 0.1.0
#
# What it does:
#   1. Verifies Node.js >= 22 is on PATH.
#   2. Picks the best available package manager (pnpm > yarn > npm).
#   3. Installs (or upgrades) @kashdao/cli globally.
#   4. Verifies the installed binary by running `kash --version`.
#
# Why a script (not just `npm i -g`)?
#   - Validates the Node version up-front with a clear error rather than
#     letting npm install a package that fails at startup.
#   - Picks the user's actual package manager so we don't leave broken
#     pnpm/yarn global metadata behind.
#   - Idempotent — re-running upgrades to the latest published version.
#
# This script is intentionally POSIX-only (no bashisms) so it runs on
# the default /bin/sh of every supported platform.

set -eu

KASH_PACKAGE="@kashdao/cli"
KASH_VERSION="latest"
KASH_REQUIRED_NODE_MAJOR=22

usage() {
  cat <<'EOF'
Kash CLI installer

Options:
  --version <semver>   Install a specific version (default: latest)
  --pm <pnpm|yarn|npm> Force a specific package manager
  --dry-run            Print the resolved command without executing it
  --help               Show this help

Environment:
  KASH_VERSION         Same as --version
  KASH_PM              Same as --pm
EOF
}

# --- arg parsing --------------------------------------------------------
KASH_PM=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) KASH_VERSION="$2"; shift 2 ;;
    --pm)      KASH_PM="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
KASH_VERSION="${KASH_VERSION:-${KASH_VERSION_ENV:-latest}}"
KASH_PM="${KASH_PM:-${KASH_PM_ENV:-}}"

# --- color helpers (gracefully degrade for non-TTY) ---------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED="$(printf '\033[31m')"
  C_GREEN="$(printf '\033[32m')"
  C_YELLOW="$(printf '\033[33m')"
  C_DIM="$(printf '\033[2m')"
  C_RESET="$(printf '\033[0m')"
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_DIM=""; C_RESET=""
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
err()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

# --- platform / node check ---------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required but was not found on PATH."
  err "Install Node.js >= ${KASH_REQUIRED_NODE_MAJOR} from https://nodejs.org or via a version manager (nvm, fnm, asdf)."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt "${KASH_REQUIRED_NODE_MAJOR}" ]; then
  err "Node.js ${KASH_REQUIRED_NODE_MAJOR}+ is required (you have $(node --version))."
  err "Upgrade via 'nvm install ${KASH_REQUIRED_NODE_MAJOR}' or your platform's package manager."
  exit 1
fi

# --- package manager selection -----------------------------------------
if [ -z "${KASH_PM}" ]; then
  if   command -v pnpm >/dev/null 2>&1; then KASH_PM="pnpm"
  elif command -v yarn >/dev/null 2>&1; then KASH_PM="yarn"
  elif command -v npm  >/dev/null 2>&1; then KASH_PM="npm"
  else
    err "No supported package manager found (pnpm/yarn/npm)."
    err "Install npm (bundled with Node.js) and re-run."
    exit 1
  fi
fi

case "${KASH_PM}" in
  npm)  CMD="npm install -g ${KASH_PACKAGE}@${KASH_VERSION}" ;;
  pnpm) CMD="pnpm add -g ${KASH_PACKAGE}@${KASH_VERSION}" ;;
  yarn) CMD="yarn global add ${KASH_PACKAGE}@${KASH_VERSION}" ;;
  *)    err "Unsupported --pm value: ${KASH_PM}"; exit 2 ;;
esac

say "$(dim "Detected:   node $(node --version), ${KASH_PM}")"
say "$(dim "Installing: ${KASH_PACKAGE}@${KASH_VERSION} via ${KASH_PM}")"
say "$(dim "Command:    ${CMD}")"

if [ "${DRY_RUN}" = 1 ]; then
  say ""
  say "$(ok "(dry run) — pass without --dry-run to execute.")"
  exit 0
fi

# --- install -----------------------------------------------------------
# Some global installs require sudo on system-managed Node installs;
# we don't auto-escalate (that's a security footgun in a curl|sh
# script). If the install fails with EACCES, the user re-runs with
# their preferred sudo strategy.
if ! sh -c "${CMD}"; then
  err ""
  err "Install command failed: ${CMD}"
  err ""
  err "Common fixes:"
  err "  - Permission errors: re-run with sudo, or install Node via a version manager"
  err "    (https://github.com/nvm-sh/nvm) so global installs land in your home directory."
  err "  - Behind a corporate proxy: set HTTPS_PROXY / HTTP_PROXY before re-running."
  exit 1
fi

# --- verify ------------------------------------------------------------
if ! command -v kash >/dev/null 2>&1; then
  warn "Install completed but 'kash' is not on PATH."
  warn "Make sure your package manager's global bin directory is on PATH:"
  warn "  pnpm:  pnpm bin -g"
  warn "  yarn:  yarn global bin"
  warn "  npm:   npm config get prefix  # then add /bin to PATH"
  exit 1
fi

say ""
ok  "Installed: $(kash --version)"
say ""
say "Next steps:"
say "  1. kash auth set-key kash_live_…       # save your API key"
say "  2. kash markets list --status ACTIVE   # browse markets"
say "  3. kash trade buy <id> --outcome 0 --amount 10 --wait"
say ""
say "Tab completion: kash completion install"
say "Docs:           https://github.com/KashDAO/cli#readme"
