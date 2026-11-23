#!/bin/bash
# Deploy all ILN contracts to Stellar testnet, initialize them explicitly, and
# verify initialization before writing a deployment summary.
#
# Required environment (or .env) variables:
#   STELLAR_TESTNET_DEPLOYER_SECRET  Testnet deployer secret (never printed).
#   ILN_ADMIN_ADDRESS                Explicit admin account for the deployment.
#   ILN_GOV_TOKEN_ADDRESS            Governance token SAC contract address.
#   ILN_GOV_TOKEN_TOTAL_SUPPLY       Governance token supply used for quorum.
#   TESTNET_USDC_SAC                 Testnet USDC SAC contract address.
#   TESTNET_EURC_SAC                 Testnet EURC SAC contract address.
#   TESTNET_XLM_SAC                  Testnet XLM SAC contract address.
#
# The deployer identity is named after the network (`iln-testnet-deployer`) so a
# testnet run can never silently reuse a key created for another network.

set -euo pipefail

# Generated deployment records may contain operator-supplied addresses.
umask 077

NETWORK="testnet"
SOURCE="iln-testnet-deployer"
SUMMARY_FILE="deploy-summary.json"
ENV_FILE=".contracts-${NETWORK}.env"
ENV_PREVIOUS="${ENV_FILE}.previous"
SUMMARY_PREVIOUS="${SUMMARY_FILE}.previous"

redact() {
  sed -E 's/S[A-Z2-7]{55}/<redacted-secret>/g'
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# Load only the deployment variables this script understands. Sourcing the
# whole .env would export unrelated secrets to every child process, and the
# deployer secret is deliberately kept out of the process environment.
load_env_file() {
  [[ -f .env ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    case "${key}" in
      STELLAR_TESTNET_DEPLOYER_SECRET|ILN_ADMIN_ADDRESS|ILN_GOV_TOKEN_ADDRESS|ILN_GOV_TOKEN_TOTAL_SUPPLY|TESTNET_USDC_SAC|TESTNET_EURC_SAC|TESTNET_XLM_SAC)
        printf -v "${key}" '%s' "${value}"
        ;;
    esac
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env || true)
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "${value}" ]] || fail "Missing required environment variable ${name}."
  printf '%s' "${value}"
}

validate_account() {
  [[ "$1" =~ ^[GM][A-Z0-9]{55}$ ]] || fail "$2 is not a valid Stellar account address."
}

validate_contract() {
  [[ "$1" =~ ^C[A-Z0-9]{55}$ ]] || fail "$2 is not a valid Stellar contract address."
}

load_env_file

SECRET="${STELLAR_TESTNET_DEPLOYER_SECRET:-}"
ADMIN_ADDRESS="$(require_var ILN_ADMIN_ADDRESS)"
GOV_TOKEN_ADDRESS="$(require_var ILN_GOV_TOKEN_ADDRESS)"
GOV_TOKEN_TOTAL_SUPPLY="$(require_var ILN_GOV_TOKEN_TOTAL_SUPPLY)"
USDC_SAC="$(require_var TESTNET_USDC_SAC)"
EURC_SAC="$(require_var TESTNET_EURC_SAC)"
XLM_SAC="$(require_var TESTNET_XLM_SAC)"

# Remove the secret from the environment before any child process runs. It is
# only ever passed to `stellar keys add` through stdin.
unset STELLAR_TESTNET_DEPLOYER_SECRET
trap 'SECRET=""' EXIT

[[ -n "${SECRET}" ]] || fail "Missing required environment variable STELLAR_TESTNET_DEPLOYER_SECRET."
[[ "${SECRET}" =~ ^S[A-Z2-7]{55}$ ]] || fail "STELLAR_TESTNET_DEPLOYER_SECRET is not a valid Stellar secret key."

validate_account "${ADMIN_ADDRESS}" ILN_ADMIN_ADDRESS
validate_contract "${GOV_TOKEN_ADDRESS}" ILN_GOV_TOKEN_ADDRESS
validate_contract "${USDC_SAC}" TESTNET_USDC_SAC
validate_contract "${EURC_SAC}" TESTNET_EURC_SAC
validate_contract "${XLM_SAC}" TESTNET_XLM_SAC
[[ "${GOV_TOKEN_TOTAL_SUPPLY}" =~ ^[0-9]+$ ]] || fail "ILN_GOV_TOKEN_TOTAL_SUPPLY must be a positive integer."
(( GOV_TOKEN_TOTAL_SUPPLY > 0 )) || fail "ILN_GOV_TOKEN_TOTAL_SUPPLY must be greater than zero."

# Ensure network config exists.
if ! stellar network ls | grep -q "^${NETWORK}$"; then
  stellar network add "${NETWORK}" \
    --rpc-url https://soroban-testnet.stellar.org \
    --network-passphrase "Test SDF Network ; September 2015"
fi

# Ensure the network-scoped deployer key exists and matches the supplied
# secret. Refusing to reuse a key whose secret differs prevents a key created
# for another network from being used silently.
if ! stellar keys address "${SOURCE}" &> /dev/null; then
  printf '%s\n' "${SECRET}" | stellar keys add "${SOURCE}" --secret-key > /dev/null 2>&1 \
    || fail "Failed to add deployer key '${SOURCE}'."
fi

EXISTING_SECRET="$(stellar keys secret "${SOURCE}" 2>/dev/null || true)"
if [[ -n "${EXISTING_SECRET}" && "${EXISTING_SECRET}" != "${SECRET}" ]]; then
  EXISTING_SECRET=""
  fail "Key '${SOURCE}' already exists with a different secret. Refusing to reuse it across networks; remove it with 'stellar keys rm ${SOURCE}' after confirming it is safe."
fi
EXISTING_SECRET=""
echo "Deployer: $(stellar keys address "${SOURCE}")"

# Build optimized WASM.
cargo build --target wasm32v1-none --release

# Strip the contractspecv0 custom section from WASM files that exceed
# the Stellar on-chain limit (128 KB). The spec is only needed for
# off-chain client generation.
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

CONTRACT_WASM_PATHS=(
  "target/wasm32v1-none/release/invoice_liquidity.wasm"
  "target/wasm32v1-none/release/iln_governance.wasm"
  "target/wasm32v1-none/release/iln_distribution.wasm"
  "target/wasm32v1-none/release/reputation_bonus.wasm"
)

CONTRACT_ID_VALUES=()

get_contract_id() {
  local wanted="$1"
  local index
  for index in "${!CONTRACT_NAMES[@]}"; do
    if [[ "${CONTRACT_NAMES[$index]}" == "${wanted}" ]]; then
      printf '%s' "${CONTRACT_ID_VALUES[$index]}"
      return 0
    fi
  done
  fail "No deployed contract ID recorded for ${wanted}."
}

# Keep the previous deployment records so scripts/verify-deployment.ts can
# roll local pointers back if post-deploy verification fails.
if [[ -f "${ENV_FILE}" ]]; then
  cp -p "${ENV_FILE}" "${ENV_PREVIOUS}"
fi
if [[ -f "${SUMMARY_FILE}" ]]; then
  cp -p "${SUMMARY_FILE}" "${SUMMARY_PREVIOUS}"
fi

for contract_index in "${!CONTRACT_NAMES[@]}"; do
  contract_name="${CONTRACT_NAMES[$contract_index]}"
  wasm_path="${CONTRACT_WASM_PATHS[$contract_index]}"

  if [[ ! -f "${wasm_path}" ]]; then
    fail "WASM not found: ${wasm_path}"
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

  upload_output=$(stellar contract upload \
    --network "${NETWORK}" \
    --source "${SOURCE}" \
    --wasm "${wasm_path}" 2>&1)

  wasm_hash=$(echo "${upload_output}" | grep -oE '[a-f0-9]{64}' | head -1 || true)
  if [[ -z "${wasm_hash}" ]]; then
    echo "Failed to upload WASM for ${contract_name}" >&2
    printf '%s\n' "${upload_output}" | redact >&2
    exit 1
  fi

  deploy_output=$(stellar contract deploy \
    --network "${NETWORK}" \
    --source "${SOURCE}" \
    --wasm-hash "${wasm_hash}" 2>&1)

  contract_id=$(echo "${deploy_output}" | grep -oE '[A-Z0-9]{56}' | tail -1 || true)
  if [[ -z "${contract_id}" ]]; then
    echo "Failed to deploy ${contract_name}" >&2
    printf '%s\n' "${deploy_output}" | redact >&2
    exit 1
  fi

  CONTRACT_ID_VALUES[$contract_index]="${contract_id}"
  echo "${contract_name}=${contract_id}"
done

INVOICE_LIQUIDITY_ID="$(get_contract_id invoice_liquidity)"
ILN_GOVERNANCE_ID="$(get_contract_id iln_governance)"
ILN_DISTRIBUTION_ID="$(get_contract_id iln_distribution)"
REPUTATION_BONUS_ID="$(get_contract_id reputation_bonus)"

init_contract() {
  local contract_name="$1"
  shift
  echo "Initializing ${contract_name}..."
  local output
  if ! output=$(stellar contract invoke \
    --network "${NETWORK}" \
    --source "${SOURCE}" \
    --id "$(get_contract_id "${contract_name}")" \
    -- "$@" 2>&1); then
    echo "Initialization failed for ${contract_name}" >&2
    printf '%s\n' "${output}" | redact >&2
    exit 1
  fi
}

verify_view() {
  local contract_name="$1"
  local function_name="$2"
  local expected="${3:-}"
  local output normalized
  if ! output=$(stellar contract invoke \
    --network "${NETWORK}" \
    --source "${SOURCE}" \
    --id "$(get_contract_id "${contract_name}")" \
    -- "${function_name}" 2>&1); then
    echo "Initialization verification failed for ${contract_name}.${function_name}" >&2
    printf '%s\n' "${output}" | redact >&2
    exit 1
  fi
  if [[ -n "${expected}" ]]; then
    normalized=$(printf '%s' "${output}" | tr -d '[:space:]"')
    if [[ "${normalized}" != "${expected}" ]]; then
      fail "${contract_name}.${function_name} returned '${normalized}', expected '${expected}'."
    fi
  fi
}

# Initialization order follows contract dependencies: invoice and distribution
# first, then reputation, then governance (which references the other three).
init_contract invoice_liquidity initialize \
  --admin "${ADMIN_ADDRESS}" \
  --usdc_token "${USDC_SAC}" \
  --eurc_token "${EURC_SAC}" \
  --xlm_token "${XLM_SAC}"

init_contract iln_distribution initialize \
  --iln_contract "${INVOICE_LIQUIDITY_ID}" \
  --gov_token "${GOV_TOKEN_ADDRESS}"

init_contract reputation_bonus init \
  --admin "${ADMIN_ADDRESS}"

init_contract iln_governance initialize \
  --iln_contract "${INVOICE_LIQUIDITY_ID}" \
  --distribution_contract "${ILN_DISTRIBUTION_ID}" \
  --reputation_bonus_contract "${REPUTATION_BONUS_ID}" \
  --gov_token "${GOV_TOKEN_ADDRESS}" \
  --admin "${ADMIN_ADDRESS}" \
  --gov_token_total_supply "${GOV_TOKEN_TOTAL_SUPPLY}"

# Verify initialization before writing any success artefacts.
verify_view invoice_liquidity get_config
verify_view iln_distribution is_initialized true
verify_view reputation_bonus get_admin "${ADMIN_ADDRESS}"
verify_view iln_governance get_gov_token_total_supply "${GOV_TOKEN_TOTAL_SUPPLY}"

echo "All contracts initialized and verified."

cat > "${ENV_FILE}" <<EOF
# Contract IDs for ${NETWORK} network
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

INVOICE_LIQUIDITY_ID=${INVOICE_LIQUIDITY_ID}
ILN_GOVERNANCE_ID=${ILN_GOVERNANCE_ID}
ILN_DISTRIBUTION_ID=${ILN_DISTRIBUTION_ID}
REPUTATION_BONUS_ID=${REPUTATION_BONUS_ID}
ILN_ADMIN_ADDRESS=${ADMIN_ADDRESS}
ILN_GOV_TOKEN_ADDRESS=${GOV_TOKEN_ADDRESS}
ILN_GOV_TOKEN_TOTAL_SUPPLY=${GOV_TOKEN_TOTAL_SUPPLY}
TESTNET_USDC_SAC=${USDC_SAC}
TESTNET_EURC_SAC=${EURC_SAC}
TESTNET_XLM_SAC=${XLM_SAC}
NETWORK=${NETWORK}
SOURCE=${SOURCE}
EOF

# ── Initialize invoice_liquidity (Issue #1162) ────────────────────────────────
# `stellar contract deploy` only installs the instance; initialization is a
# separate, *authenticated* transaction. Leaving it to a later public window
# would let an arbitrary first caller become admin (and thereby control fees,
# tokens, oracle settings, pause state, upgrades and migrations), so we
# initialize here, signed by the deployer.
#
#   INVOICE_LIQUIDITY_ADMIN  admin address (default: the deployer)
#   TESTNET_XLM_SAC          native XLM SAC (default: known testnet SAC)
#   TESTNET_USDC_SAC         USDC SAC   (default: native XLM SAC)
#   TESTNET_EURC_SAC         EURC SAC   (default: native XLM SAC)
#
# If INVOICE_LIQUIDITY_ADMIN is an identity other than the deployer, the
# deployer cannot authorize on its behalf: run the `initialize` step yourself
# with `--source <admin-key>` (see docs/initialization-hardening.md).
INVOICE_LIQUIDITY_ID="${CONTRACT_IDS[invoice_liquidity]}"
DEPLOYER_ADDRESS="$(stellar keys address "${SOURCE}")"
INIT_ADMIN="${INVOICE_LIQUIDITY_ADMIN:-${DEPLOYER_ADDRESS}}"
XLM_SAC="${TESTNET_XLM_SAC:-CDLZ472EC4UB7SA74XCHWYVEGERSIJU224RLUXEDCXTCW6U537BC7D37}"
USDC_SAC="${TESTNET_USDC_SAC:-$XLM_SAC}"
EURC_SAC="${TESTNET_EURC_SAC:-$XLM_SAC}"

if [[ "${INIT_ADMIN}" != "${DEPLOYER_ADDRESS}" ]]; then
  echo "⚠️  INVOICE_LIQUIDITY_ADMIN (${INIT_ADMIN}) differs from the deployer."
  echo "   The deployer cannot authorize on its behalf — run the initializer with"
  echo "   the admin key instead:"
  echo "     stellar contract invoke --network ${NETWORK} --source <admin-key> \\"
  echo "       --id ${INVOICE_LIQUIDITY_ID} -- initialize \\"
  echo "       --admin ${INIT_ADMIN} --usdc_token ${USDC_SAC} \\"
  echo "       --eurc_token ${EURC_SAC} --xlm_token ${XLM_SAC}"
else
  echo "Initializing invoice_liquidity (${INVOICE_LIQUIDITY_ID})..."
  set +e
  init_output=$(stellar contract invoke \
    --network "${NETWORK}" \
    --source "${SOURCE}" \
    --id "${INVOICE_LIQUIDITY_ID}" \
    -- initialize \
    --admin "${INIT_ADMIN}" \
    --usdc_token "${USDC_SAC}" \
    --eurc_token "${EURC_SAC}" \
    --xlm_token "${XLM_SAC}" 2>&1)
  init_status=$?
  set -e
  if [[ ${init_status} -ne 0 ]]; then
    if echo "${init_output}" | grep -qiE 'AlreadyInitialized|already initialized'; then
      echo "invoice_liquidity already initialized — skipping."
    else
      echo "invoice_liquidity initialization failed:" >&2
      echo "${init_output}" >&2
      exit 1
    fi
  fi
fi

cat > "${SUMMARY_FILE}" <<EOF
{
  "network": "${NETWORK}",
  "initialized": true,
  "admin": "${ADMIN_ADDRESS}",
  "invoice_liquidity": "${INVOICE_LIQUIDITY_ID}",
  "iln_governance": "${ILN_GOVERNANCE_ID}",
  "iln_distribution": "${ILN_DISTRIBUTION_ID}",
  "reputation_bonus": "${REPUTATION_BONUS_ID}"
}
EOF

echo "Summary written to ${SUMMARY_FILE}"
