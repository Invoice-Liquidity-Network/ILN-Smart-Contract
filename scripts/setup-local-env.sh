#!/bin/bash
# Setup script for local ILN development environment
# This script:
# 1. Checks all prerequisites (Docker, Stellar CLI, Rust WASM target)
# 2. Starts the local Stellar node
# 3. Waits for the node to be healthy
# 4. Configures Stellar CLI for local network
# 5. Creates and funds a test account (alice)
# 
# Usage: ./scripts/setup-local-env.sh

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=== Setting up local development environment ==="
echo ""

# Check Docker
echo -n "Checking Docker... "
if ! command -v docker &> /dev/null; then
  echo -e "${RED}❌ Not found${NC}"
  echo "Please install Docker from https://www.docker.com"
  exit 1
fi
DOCKER_VERSION=$(docker --version | awk '{print $3}' | sed 's/,//')
echo -e "${GREEN}✓${NC} ($DOCKER_VERSION)"

# Check Docker Compose
echo -n "Checking Docker Compose... "
if ! command -v docker &> /dev/null || ! docker compose version &> /dev/null; then
  echo -e "${RED}❌ Not found${NC}"
  echo "Please install Docker Compose (https://docs.docker.com/compose/install/)"
  exit 1
fi
echo -e "${GREEN}✓${NC}"

# Check Rust
echo -n "Checking Rust... "
if ! command -v rustc &> /dev/null; then
  echo -e "${RED}❌ Not found${NC}"
  echo "Please install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi
RUST_VERSION=$(rustc --version | awk '{print $2}')
echo -e "${GREEN}✓${NC} ($RUST_VERSION)"

# Check Stellar CLI
echo -n "Checking Stellar CLI... "
if ! command -v stellar &> /dev/null; then
  echo -e "${YELLOW}Installing${NC}"
  cargo install --locked stellar-cli
else
  STELLAR_VERSION=$(stellar --version | awk '{print $2}')
  echo -e "${GREEN}✓${NC} ($STELLAR_VERSION)"
fi

# Check WASM target
echo -n "Checking WASM target (wasm32v1-none)... "
if ! rustup target list --installed 2>/dev/null | grep -q wasm32v1-none; then
  echo -e "${YELLOW}Installing${NC}"
  rustup target add wasm32v1-none
else
  echo -e "${GREEN}✓${NC}"
fi

echo ""
echo "=== Starting Stellar Node ==="
echo ""

# Start Stellar node
echo "Starting local Stellar node via Docker..."
docker compose up -d stellar

# Wait for node to be healthy
echo "Waiting for Stellar node to be healthy..."
HEALTH_CHECK_ATTEMPTS=0
MAX_ATTEMPTS=30

while [ $HEALTH_CHECK_ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  if docker compose exec -T stellar curl -s http://localhost:8000/ledger > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Stellar node is healthy"
    break
  fi
  HEALTH_CHECK_ATTEMPTS=$((HEALTH_CHECK_ATTEMPTS + 1))
  echo "  Waiting... ($HEALTH_CHECK_ATTEMPTS/$MAX_ATTEMPTS)"
  sleep 2
done

if [ $HEALTH_CHECK_ATTEMPTS -eq $MAX_ATTEMPTS ]; then
  echo -e "${RED}❌ Stellar node failed to become healthy${NC}"
  echo "Check logs: docker compose logs stellar"
  exit 1
fi

echo ""
echo "=== Configuring Stellar CLI ==="
echo ""

# Configure local network
echo "Configuring 'local' network..."
stellar network add \
  --global local \
  --rpc-url http://localhost:8000 \
  --network-passphrase "Standalone Network ; February 2021" \
  --override || true

# Create test account
echo "Creating test account (alice)..."
stellar keys generate --global alice || true

ALICE=$(stellar keys address alice)
echo "Account address: $ALICE"

# Fund the account
echo "Funding alice with 10,000 XLM..."
stellar account fund alice --network local || true

echo ""
echo -e "${GREEN}✅ Local development environment is ready!${NC}"
echo ""
echo "Next steps:"
echo "  1. Build contracts:  cargo build --target wasm32v1-none --release"
echo "  2. Run tests:        cargo test"
echo "  3. Deploy locally:   ./scripts/deploy-local.sh"
echo ""
echo "View detailed docs at: docs/local-development.md"
echo ""
echo "To stop the Stellar node: docker compose down"
echo "To view logs:            docker compose logs -f stellar"
