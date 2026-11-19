#!/usr/bin/env bash
# check-npm-licenses.sh — Verify production npm dependencies have compatible licenses.
# Usage: ./scripts/check-npm-licenses.sh [workspace-root]
#
# Requires: node >= 22, pnpm, license-checker (installed automatically if missing).

set -euo pipefail

WORKSPACE_ROOT="${1:-.}"
cd "$WORKSPACE_ROOT"

# Ensure license-checker is available
if ! npx license-checker --version >/dev/null 2>&1; then
  echo "Installing license-checker..."
  pnpm add -Dw license-checker
fi

echo "Checking production dependency licenses..."

# Fail on copyleft or known-incompatible licenses
FAIL_PATTERNS="GPL-3.0;GPL-2.0;AGPL-3.0;SSPL-1.0;BSL-1.0;EUPL-1.1;CC-BY-NC-4.0"

npx license-checker --production --failOn "$FAIL_PATTERNS" --summary

echo ""
echo "All production dependencies have compatible licenses."
