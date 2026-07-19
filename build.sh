#!/usr/bin/env bash
#
# Builds the extension from a clean checkout, in one step.
#
#   ./build.sh
#
# Output: dist/ — this directory IS the extension. The submitted archive is
# dist/ zipped, with nothing added or removed.
#
# Requirements are checked below and the script fails loudly rather than
# producing a subtly different build.

set -euo pipefail

cd "$(dirname "$0")"

# --- Node 24+ ----------------------------------------------------------------
#
# Not a preference. build.mjs and the test suite execute .ts files directly
# through Node's native type stripping, which does not exist before 24.

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found. Install Node 24 or later from https://nodejs.org/" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "error: Node $(node -v) found, but 24 or later is required." >&2
  echo "       This project runs .ts files directly via native type stripping." >&2
  exit 1
fi

# --- pnpm 11 -----------------------------------------------------------------
#
# Shipped with Node via corepack, so no separate download is needed.

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found; activating it through corepack…" >&2
  corepack enable
  corepack prepare pnpm@11.11.0 --activate
fi

echo "node   $(node -v)"
echo "pnpm   $(pnpm --version)"
echo

# --- build -------------------------------------------------------------------

pnpm install --frozen-lockfile
pnpm build

echo
echo "Built into dist/:"
find dist -type f | sort | sed 's/^/  /'
echo
echo "This is the extension. To produce the submitted archive:  pnpm package"
