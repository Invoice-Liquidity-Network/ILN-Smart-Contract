#!/bin/bash
# Publish verified mainnet contract IDs and SAC addresses to README.md.
#
# This is the mainnet counterpart to scripts/update-testnet-readme.sh. It
# exists because hand-copying 56-character strkey addresses out of a
# deployment log into README.md is exactly the kind of transcription error
# that is expensive on a financial protocol (Issue #650). It removes the
# manual copy/paste step and refuses to publish anything that has not passed
# a green scripts/verify-deployment.ts run (Issue #649).
#
# Usage:
#   bash scripts/publish-mainnet-contracts.sh
#
# Inputs:
#   .contracts-mainnet.env           Contract IDs for the mainnet deployment
#                                     (produced by the mainnet deploy step).
#   verification-report.mainnet.json Report produced by:
#                                       NETWORK=mainnet npx tsx scripts/verify-deployment.ts
#                                     Must show allPassed=true.
#
# Env overrides:
#   ENV_FILE          Path to the contract-id env file (default: .contracts-mainnet.env)
#   REPORT_FILE       Path to the verification report (default: verification-report.mainnet.json)
#   MAINNET_USDC_SAC  Mainnet USDC SAC contract address (required)
#   SKIP_VERIFICATION Set to "1" to bypass the verification-report gate (not
#                      recommended; only for re-publishing an already-verified
#                      table, e.g. after an unrelated README edit).

set -euo pipefail

ENV_FILE="${ENV_FILE:-.contracts-mainnet.env}"
REPORT_FILE="${REPORT_FILE:-verification-report.mainnet.json}"
README_FILE="README.md"
SKIP_VERIFICATION="${SKIP_VERIFICATION:-0}"

# Strkey contract addresses are 56 characters, base32 upper-case, and start
# with 'C'. Validating the shape here catches truncated copy/pastes and
# wrong-network addresses (e.g. a testnet SAC pasted into a mainnet run)
# before they ever reach README.md.
CONTRACT_ID_RE='^C[A-Z2-7]{55}$'

validate_contract_id() {
  local label="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    echo "Missing ${label} in ${ENV_FILE}." >&2
    exit 1
  fi
  if ! [[ "${value}" =~ ${CONTRACT_ID_RE} ]]; then
    echo "Invalid ${label}: '${value}' does not look like a Stellar contract address." >&2
    exit 1
  fi
}

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Run the mainnet deploy step first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

if [[ "${NETWORK:-}" != "mainnet" ]]; then
  echo "${ENV_FILE} does not declare NETWORK=mainnet (found '${NETWORK:-<unset>}')." >&2
  echo "Refusing to publish — this script only publishes mainnet addresses." >&2
  exit 1
fi

if [[ -z "${MAINNET_USDC_SAC:-}" ]]; then
  echo "MAINNET_USDC_SAC is not set. Export the mainnet USDC SAC contract address before publishing." >&2
  exit 1
fi

validate_contract_id "INVOICE_LIQUIDITY_ID" "${INVOICE_LIQUIDITY_ID:-}"
validate_contract_id "ILN_GOVERNANCE_ID" "${ILN_GOVERNANCE_ID:-}"
validate_contract_id "ILN_DISTRIBUTION_ID" "${ILN_DISTRIBUTION_ID:-}"
validate_contract_id "REPUTATION_BONUS_ID" "${REPUTATION_BONUS_ID:-}"
validate_contract_id "MAINNET_USDC_SAC" "${MAINNET_USDC_SAC}"
if [[ -n "${INSURANCE_POOL_ID:-}" ]]; then
  validate_contract_id "INSURANCE_POOL_ID" "${INSURANCE_POOL_ID}"
fi

if [[ "${SKIP_VERIFICATION}" != "1" ]]; then
  if [[ ! -f "${REPORT_FILE}" ]]; then
    echo "Missing ${REPORT_FILE}." >&2
    echo "Run 'NETWORK=mainnet npx tsx scripts/verify-deployment.ts' first — contract IDs" >&2
    echo "must pass verification before they can be published. (Set SKIP_VERIFICATION=1" >&2
    echo "to bypass, e.g. when only re-publishing an unrelated README change.)" >&2
    exit 1
  fi

  REPORT_NETWORK=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('network',''))" "${REPORT_FILE}")
  REPORT_ALL_PASSED=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('allPassed', False))" "${REPORT_FILE}")

  if [[ "${REPORT_NETWORK}" != "mainnet" ]]; then
    echo "${REPORT_FILE} is a report for network '${REPORT_NETWORK}', not mainnet." >&2
    exit 1
  fi
  if [[ "${REPORT_ALL_PASSED}" != "True" ]]; then
    echo "${REPORT_FILE} reports failing checks (allPassed=${REPORT_ALL_PASSED})." >&2
    echo "Fix the failures and re-run verify-deployment.ts before publishing." >&2
    exit 1
  fi
  echo "Verification report OK (${REPORT_FILE}: network=mainnet, allPassed=true)."
else
  echo "SKIP_VERIFICATION=1 — publishing without checking a verification report." >&2
fi

TABLE_CONTENT=$(cat <<EOF
| Resource | Contract ID | Notes |
|----------|-------------|-------|
| **\`invoice_liquidity\`** | \`${INVOICE_LIQUIDITY_ID}\` | Primary integration contract; used in [SDK examples](docs/sdk-integration.md) |
| **\`iln_governance\`** | \`${ILN_GOVERNANCE_ID}\` | Governance proposals and voting |
| **\`iln_distribution\`** | \`${ILN_DISTRIBUTION_ID}\` | Rewards distribution |
| **\`reputation_bonus\`** | \`${REPUTATION_BONUS_ID}\` | Reputation-based bonus rules |
EOF
)

if [[ -n "${INSURANCE_POOL_ID:-}" ]]; then
  TABLE_CONTENT="${TABLE_CONTENT}
| **\`insurance_pool\`** | \`${INSURANCE_POOL_ID}\` | Default-protection insurance pool |"
fi

TABLE_CONTENT="${TABLE_CONTENT}
| **Mainnet USDC (SAC)** | \`${MAINNET_USDC_SAC}\` | Referenced in SDK integration guide |"

export README_MAINNET_TABLE="${TABLE_CONTENT}"

python3 - <<'PY'
import os
import re
import sys

path = "README.md"
start = "<!-- MAINNET_CONTRACT_IDS_START -->"
end = "<!-- MAINNET_CONTRACT_IDS_END -->"

with open(path, "r", encoding="utf-8") as handle:
    content = handle.read()

if start not in content or end not in content:
    print("Missing mainnet contract markers in README.md", file=sys.stderr)
    sys.exit(1)

table = os.environ["README_MAINNET_TABLE"].rstrip()
replacement = f"{start}\n{table}\n{end}"

pattern = re.compile(rf"{re.escape(start)}.*?{re.escape(end)}", re.S)
updated = pattern.sub(replacement, content)

if updated == content:
    print("README already up to date")
else:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(updated)
    print("README updated with verified mainnet contract addresses")
PY
