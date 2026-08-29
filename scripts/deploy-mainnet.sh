#!/bin/bash
# Deploy the four core ILN contracts to Stellar mainnet.
#
# This is the mainnet counterpart to scripts/deploy-testnet.sh. It differs
# from the testnet script in the ways that matter for a live financial
# protocol (Issue #648):
#   - Requires a typed confirmation phrase before submitting any transaction.
#   - Never auto-funds the deployer (mainnet has no friendbot) — it checks
#     the balance and aborts if insufficient instead.
#   - Supports --dry-run, which runs every pre-flight check and prints the
#     exact commands that would run, without uploading or deploying anything.
#
# Usage:
#   bash scripts/deploy-mainnet.sh --dry-run
#   CONFIRM="DEPLOY TO MAINNET" bash scripts/deploy-mainnet.sh
#
# Required env vars (live run only):
#   STELLAR_MAINNET_DEPLOYER_SECRET   Secret key for the deployer/source account.
#   CONFIRM                           Must equal the literal phrase
#                                     "DEPLOY TO MAINNET" or the script aborts.
#
# See docs/mainnet-deployment-runbook.md for the full procedure.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

NETWORK="mainnet"
SOURCE="mainnet-deployer"
SUMMARY_FILE="deploy-summary-mainnet.json"
ENV_FILE=".contracts-${NETWORK}.env"
CONFIRM_PHRASE="DEPLOY TO MAINNET"
MIN_XLM_BALANCE=20

echo "=== ILN Mainnet Deploy ==="
echo "Mode: $([[ "${DRY_RUN}" -eq 1 ]] && echo DRY-RUN || echo LIVE)"
echo ""

if [[ "${DRY_RUN}" -ne 1 && "${CONFIRM:-}" != "${CONFIRM_PHRASE}" ]]; then
  echo "Refusing to deploy: set CONFIRM=\"${CONFIRM_PHRASE}\" to acknowledge this is a live mainnet deployment." >&2
  exit 1
fi

# [1/5] Network configuration
echo "[1/5] Checking network configuration..."
if ! stellar network ls | grep -q "^${NETWORK}$"; then
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  (dry-run) Would add network '${NETWORK}' — not configured yet."
  else
    echo "Network '${NETWORK}' is not configured." >&2
    echo "Configure it with: stellar network add --global ${NETWORK} --rpc-url <mainnet-rpc-url> --network-passphrase \"Public Global Stellar Network ; September 2015\"" >&2
    exit 1
  fi
else
  echo "  Network '${NETWORK}' is configured."
fi

# [2/5] Deployer key + balance (never auto-funded on mainnet)
echo ""
echo "[2/5] Checking deployer account..."
if ! stellar keys address "${SOURCE}" &> /dev/null; then
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  (dry-run) Deployer key '${SOURCE}' does not exist yet — would need to be added from STELLAR_MAINNET_DEPLOYER_SECRET."
  else
    if [[ -z "${STELLAR_MAINNET_DEPLOYER_SECRET:-}" ]]; then
      echo "Missing STELLAR_MAINNET_DEPLOYER_SECRET and no '${SOURCE}' key found." >&2
      exit 1
    fi
    stellar keys add "${SOURCE}" --secret-key <<< "${STELLAR_MAINNET_DEPLOYER_SECRET}"
  fi
fi

if [[ "${DRY_RUN}" -ne 1 ]]; then
  BALANCE=$(stellar keys balance "${SOURCE}" --network "${NETWORK}" 2>/dev/null || echo "0")
  BALANCE_NUM=$(echo "${BALANCE}" | grep -oE '^[0-9]+(\.[0-9]+)?' || echo "0")
  if (( $(echo "${BALANCE_NUM} < ${MIN_XLM_BALANCE}" | bc -l 2>/dev/null || echo 1) )); then
    echo "Deployer balance is ${BALANCE} XLM — below the recommended minimum of ${MIN_XLM_BALANCE} XLM for four contract deploys." >&2
    echo "Fund the account manually — mainnet has no friendbot." >&2
    exit 1
  fi
  echo "  Deployer balance: ${BALANCE} XLM (sufficient)."
else
  echo "  (dry-run) Would check '${SOURCE}' balance >= ${MIN_XLM_BALANCE} XLM."
fi

# [3/5] Build + shrink WASM
echo ""
echo "[3/5] Building optimized WASM..."
cargo build --target wasm32v1-none --release

strip_spec() {
  python3 -c "
import sys
with open(sys.argv[1], 'rb') as f:
    data = bytearray(f.read())
i = 8
out = data[:i]
while i < len(data):
    sec_id = data[i]; j = i + 1
    size = 0; shift = 0
    while j < len(data):
        byte = data[j]; size |= (byte & 0x7F) << shift; j += 1; shift += 7
        if byte < 0x80: break
    sec_end = j + size
    if sec_id == 0:
        k = j; name_len = 0; shift = 0
        while k < sec_end:
            byte = data[k]; name_len |= (byte & 0x7F) << shift; k += 1; shift += 7
            if byte < 0x80: break
        name = data[k:k+name_len].decode('utf-8', errors='replace')
        if name == 'contractspecv0':
            print(f'  Stripped {name} ({sec_end - i} bytes)')
            i = sec_end; continue
    out.extend(data[i:sec_end]); i = sec_end
with open(sys.argv[1], 'wb') as f: f.write(out)
" "$1"
}

CONTRACT_NAMES=(
  invoice_liquidity
  iln_governance
  iln_distribution
  reputation_bonus
)

declare -A CONTRACTS=(
  ["invoice_liquidity"]="target/wasm32v1-none/release/invoice_liquidity.wasm"
  ["iln_governance"]="target/wasm32v1-none/release/iln_governance.wasm"
  ["iln_distribution"]="target/wasm32v1-none/release/iln_distribution.wasm"
  ["reputation_bonus"]="target/wasm32v1-none/release/reputation_bonus.wasm"
)

for contract_name in "${CONTRACT_NAMES[@]}"; do
  wasm_path="${CONTRACTS[$contract_name]}"
  if [[ ! -f "${wasm_path}" ]]; then
    echo "WASM not found: ${wasm_path}" >&2
    exit 1
  fi

  wasm_size=$(wc -c < "${wasm_path}")
  if [[ "${wasm_size}" -gt 131072 ]]; then
    echo "${contract_name}: ${wasm_size} bytes exceeds 128 KB limit, stripping spec..."
    strip_spec "${wasm_path}"
    wasm_size=$(wc -c < "${wasm_path}")
  fi
  if [[ "${wasm_size}" -gt 131072 ]]; then
    echo "${contract_name}: still ${wasm_size} bytes, running wasm-opt..."
    wasm-opt -Oz --strip-debug --strip-producers --strip-target-features \
      --strip-toolchain-annotations --zero-filled-memory \
      -o "${wasm_path}.tmp" "${wasm_path}"
    mv "${wasm_path}.tmp" "${wasm_path}"
  fi
  echo "  ${contract_name}: $((wasm_size / 1024)) KB (OK)"
done

# [4/5] Deploy (or print the plan)
echo ""
echo "[4/5] Deploying contracts..."
declare -A CONTRACT_IDS

for contract_name in "${CONTRACT_NAMES[@]}"; do
  wasm_path="${CONTRACTS[$contract_name]}"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo ""
    echo "  (dry-run) Would run:"
    echo "    stellar contract upload --network ${NETWORK} --source ${SOURCE} --wasm ${wasm_path}"
    echo "    stellar contract deploy --network ${NETWORK} --source ${SOURCE} --wasm-hash <hash-from-upload>"
    CONTRACT_IDS[${contract_name}]="DRY_RUN_PLACEHOLDER"
    continue
  fi

  echo ""
  echo "  Deploying ${contract_name}..."
  upload_output=$(stellar contract upload \
    --network "${NETWORK}" \
    --source "${SOURCE}" \
    --wasm "${wasm_path}" 2>&1)

  wasm_hash=$(echo "${upload_output}" | grep -oP '\b[a-f0-9]{64}\b' | head -1 || true)
  if [[ -z "${wasm_hash}" ]]; then
    echo "Failed to upload WASM for ${contract_name}" >&2
    echo "${upload_output}" >&2
    exit 1
  fi

  deploy_output=$(stellar contract deploy \
    --network "${NETWORK}" \
    --source "${SOURCE}" \
    --wasm-hash "${wasm_hash}" 2>&1)

  contract_id=$(echo "${deploy_output}" | grep -oP '[A-Z0-9]{56}' | tail -1 || true)
  if [[ -z "${contract_id}" ]]; then
    echo "Failed to deploy ${contract_name}" >&2
    echo "${deploy_output}" >&2
    exit 1
  fi

  CONTRACT_IDS[${contract_name}]="${contract_id}"
  echo "  ${contract_name}=${contract_id}"
done

# [5/5] Persist results
echo ""
echo "[5/5] Writing deployment records..."
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "  (dry-run) Would write ${ENV_FILE} and ${SUMMARY_FILE}. No files written."
  echo ""
  echo "Dry run complete. No transactions were submitted."
  exit 0
fi

cat > "${ENV_FILE}" <<EOF
# Contract IDs for ${NETWORK} network
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

INVOICE_LIQUIDITY_ID=${CONTRACT_IDS[invoice_liquidity]}
ILN_GOVERNANCE_ID=${CONTRACT_IDS[iln_governance]}
ILN_DISTRIBUTION_ID=${CONTRACT_IDS[iln_distribution]}
REPUTATION_BONUS_ID=${CONTRACT_IDS[reputation_bonus]}
NETWORK=${NETWORK}
SOURCE=${SOURCE}
MAINNET_USDC_SAC=${MAINNET_USDC_SAC:-}
EOF

cat > "${SUMMARY_FILE}" <<EOF
{
  "network": "${NETWORK}",
  "invoice_liquidity": "${CONTRACT_IDS[invoice_liquidity]}",
  "iln_governance": "${CONTRACT_IDS[iln_governance]}",
  "iln_distribution": "${CONTRACT_IDS[iln_distribution]}",
  "reputation_bonus": "${CONTRACT_IDS[reputation_bonus]}"
}
EOF

echo "  Wrote ${ENV_FILE} and ${SUMMARY_FILE}"
echo ""
echo "Deployment complete. Next: run 'make verify-mainnet' then 'make publish-mainnet'."
echo "See docs/mainnet-deployment-runbook.md for the remaining sign-off steps."
