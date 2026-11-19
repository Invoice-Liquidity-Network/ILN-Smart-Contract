#!/bin/bash
# Reset testnet: deploy fresh contracts, seed data, and verify.
# Usage:
#   npm run reset-testnet          # interactive (prompts for confirmation)
#   npm run reset-testnet -- --yes # skip confirmation (for CI)

set -euo pipefail

SKIP_CONFIRM=false
for arg in "$@"; do
  if [[ "$arg" == "--yes" || "$arg" == "-y" ]]; then
    SKIP_CONFIRM=true
  fi
done

if [[ "$SKIP_CONFIRM" == false ]]; then
  echo "⚠️  This will wipe all testnet data and deploy fresh contracts."
  read -p "Continue? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== Step 1: Deploying fresh contracts ==="
bash scripts/deploy-testnet.sh

echo ""
echo "=== Step 2: Seeding test data ==="
npx tsx scripts/seed.ts

echo ""
echo "=== Step 3: Verifying deployment ==="
npx tsx scripts/verify-deployment.ts

echo ""
echo "=== Step 4: Updating testnet README ==="
bash scripts/update-testnet-readme.sh

echo ""
echo "✅ Testnet reset complete."
if [[ -f .contracts-testnet.env ]]; then
  echo ""
  echo "New contract IDs:"
  grep "_ID=" .contracts-testnet.env
fi
