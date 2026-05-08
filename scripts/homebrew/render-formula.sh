#!/usr/bin/env sh
# Render the Homebrew formula for a given @kashdao/cli release.
#
# Usage:
#   scripts/homebrew/render-formula.sh <version> > kash.rb
#
# Fetches the npm tarball metadata, computes the sha256, and substitutes
# the __VERSION__ / __TARBALL_SHA__ tokens in the template.
#
# Run from the release workflow after `npm publish` lands the new
# version on the registry. The output is then PR'd into
# https://github.com/KashDAO/homebrew-tap/blob/main/Formula/kash.rb.

set -eu

VERSION="${1:-}"
if [ -z "${VERSION}" ]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi

TEMPLATE="$(dirname "$0")/kash.rb"
if [ ! -f "${TEMPLATE}" ]; then
  echo "template not found: ${TEMPLATE}" >&2
  exit 1
fi

# Fetch the tarball metadata from the npm registry. `dist.shasum` is
# sha1 (legacy); we need sha256 — recompute locally.
TARBALL_URL="https://registry.npmjs.org/@kashdao/cli/-/cli-${VERSION}.tgz"
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

curl -fsSL "${TARBALL_URL}" -o "${TMP}"
SHA256="$(shasum -a 256 "${TMP}" | awk '{print $1}')"

if [ -z "${SHA256}" ]; then
  echo "failed to compute sha256 for ${TARBALL_URL}" >&2
  exit 1
fi

sed -e "s/__VERSION__/${VERSION}/g" -e "s/__TARBALL_SHA__/${SHA256}/g" "${TEMPLATE}"
