#!/bin/bash
# Deploy all ILN contracts to local Stellar network
#
# Prerequisites:
#   - Local Stellar node running (docker compose up -d stellar)
#   - Stellar CLI configured for 'local' network
#   - Test account funded (./scripts/setup-local-env.sh)
#
# Usage: ./scripts/deploy-local.sh [network] [source]
#   network: local (default) or testnet
#   source:  alice (default) or other account name

set -euo pipefail

NETWORK="${1:-local}"
SOURCE="${2:-alice}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== Deploying ILN contracts to $NETWORK ==="
echo "Source account: $SOURCE"
echo ""

# Verify network exists
if ! stellar network ls | grep -q "^$NETWORK"; then
  echo -e "${RED}❌ Network '$NETWORK' not configured${NC}"
  echo "Configure it with: stellar network add --global $NETWORK --rpc-url <url>"
  exit 1
fi

# Verify account exists
if ! stellar keys address "$SOURCE" &> /dev/null; then
  echo -e "${RED}❌ Account '$SOURCE' not found${NC}"
  echo "Create it with: stellar keys generate --global $SOURCE"
  exit 1
fi

# Build contracts
echo "Building contracts..."
cargo build --target wasm32v1-none --release --quiet

# Define contracts
declare -A CONTRACTS=(
  ["invoice_liquidity"]="target/wasm32v1-none/release/invoice_liquidity.wasm"
  ["iln_governance"]="target/wasm32v1-none/release/iln_governance.wasm"
  ["iln_distribution"]="target/wasm32v1-none/release/iln_distribution.wasm"
  ["reputation_bonus"]="target/wasm32v1-none/release/reputation_bonus.wasm"
  ["insurance_pool"]="target/wasm32v1-none/release/insurance_pool.wasm"
)

declare -A CONTRACT_IDS

# Deploy each contract
for contract_name in "${!CONTRACTS[@]}"; do
  wasm_path="${CONTRACTS[$contract_name]}"
  
  if [[ ! -f "$wasm_path" ]]; then
    echo -e "${RED}❌ WASM not found: $wasm_path${NC}"
    exit 1
  fi
  
  echo ""
  echo "Deploying $contract_name..."
  
  # Upload WASM and extract hash
  echo "  Uploading WASM..."
  UPLOAD_OUTPUT=$(stellar contract upload \
    --network "$NETWORK" \
    --source "$SOURCE" \
    --wasm "$wasm_path" 2>&1)
  
  WASM_HASH=$(echo "$UPLOAD_OUTPUT" | grep -oP 'WASM hash: \K[a-f0-9]+' || true)
  
  if [[ -z "$WASM_HASH" ]]; then
    echo -e "${RED}❌ Failed to upload WASM for $contract_name${NC}"
    echo "$UPLOAD_OUTPUT"
    exit 1
  fi
  
  echo "  WASM hash: $WASM_HASH"
  
  # Deploy contract
  echo "  Deploying contract..."
  DEPLOY_OUTPUT=$(stellar contract deploy \
    --network "$NETWORK" \
    --source "$SOURCE" \
    --wasm-hash "$WASM_HASH" 2>&1)
  
  CONTRACT_ID=$(echo "$DEPLOY_OUTPUT" | grep -oP 'Contract ID: \K[A-Z0-9]+' || true)
  
  if [[ -z "$CONTRACT_ID" ]]; then
    echo -e "${RED}❌ Failed to deploy contract $contract_name${NC}"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi
  
  CONTRACT_IDS[$contract_name]=$CONTRACT_ID
  echo -e "  ${GREEN}✓${NC} Deployed: $CONTRACT_ID"
done

# Display summary
echo ""
echo "=== Deployment Summary ==="
for contract_name in "${!CONTRACT_IDS[@]}"; do
  echo "$contract_name:"
  echo "  ${CONTRACT_IDS[$contract_name]}"
done

# Save to environment file
ENV_FILE=".contracts-${NETWORK}.env"
cat > "$ENV_FILE" <<EOF
# Contract IDs for $NETWORK network
# Generated: $(date)

INVOICE_LIQUIDITY_ID=${CONTRACT_IDS[invoice_liquidity]:-}
ILN_GOVERNANCE_ID=${CONTRACT_IDS[iln_governance]:-}
ILN_DISTRIBUTION_ID=${CONTRACT_IDS[iln_distribution]:-}
REPUTATION_BONUS_ID=${CONTRACT_IDS[reputation_bonus]:-}
INSURANCE_POOL_ID=${CONTRACT_IDS[insurance_pool]:-}
NETWORK=$NETWORK
SOURCE=$SOURCE
EOF

echo ""
echo -e "${GREEN}✅ All contracts deployed!${NC}"
echo "Contract IDs saved to: $ENV_FILE"
echo ""
echo "To invoke a contract:"
echo "  stellar contract invoke --network $NETWORK --source $SOURCE \\"
echo "    --id \${INVOICE_LIQUIDITY_ID} -- <function> [args...]"
