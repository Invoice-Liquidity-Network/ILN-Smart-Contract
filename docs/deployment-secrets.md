# Deployment Secrets Management

This document describes the custody and rotation procedures for secrets used in testnet and mainnet deployments.

**Status:** Production-ready  
**Owner:** Release lead  
**Last reviewed:** 2026-09-26

---

## 1. Overview

Deployment secrets fall into two categories:

1. **Testnet secrets** — used in GitHub Actions CI workflows for automated testnet deployments; stored in GitHub Actions secrets.
2. **Mainnet secrets** — used for production deploys; stored in an external vault separate from CI, with restricted access and audit logging.

This separation ensures that a CI compromise cannot leak mainnet credentials.

---

## 2. Testnet Secret Custody

### Current setup

Testnet deployment uses a single secret stored in GitHub Actions:

| Secret | Value | Usage | Rotation |
|--------|-------|-------|----------|
| `STELLAR_TESTNET_DEPLOYER_SECRET` | Testnet deployer account secret key | `scripts/deploy-testnet.sh` invoked by `.github/workflows/deploy-testnet.yml` | Quarterly or on key compromise |

### Custody chain

1. **Generation:** Testnet deployer key generated locally with `stellar keys generate --global testnet-deployer`.
2. **GitHub storage:** Secret key stored in GitHub Actions repository secrets (encrypted at rest, decrypted only for Actions workflows).
3. **Workflow access:** Only the `deploy-testnet.yml` workflow can read this secret.
4. **Logs:** GitHub Actions logs are protected; secret values are masked and not displayed even in verbose output.

### Security properties

- ✅ Secret encrypted at rest in GitHub.
- ✅ Only accessible within Actions runners for the configured repository.
- ✅ Audit log available via GitHub organization settings.
- ✅ Secret rotation does not require downtime (old key is simply retired).
- ⚠️ If the GitHub Actions runner or a Actions workflow is compromised, the testnet deployer key is at risk. Mitigation: rotate immediately and audit all testnet deployments.

### Rotation procedure

**Quarterly rotation:**

```bash
# 1. Generate a new testnet deployer keypair
stellar keys generate --global testnet-deployer-new

# 2. Fund the new account with XLM (e.g., from an existing account or faucet)
stellar network fund testnet-deployer-new --network testnet

# 3. Test the new key works (optional, but recommended)
stellar contract deploy \
  --source testnet-deployer-new \
  --network testnet \
  --wasm /path/to/test-contract.wasm

# 4. Update the GitHub secret
#    - Go to Settings → Secrets and variables → Actions
#    - Edit STELLAR_TESTNET_DEPLOYER_SECRET
#    - Set value to output of: stellar keys show testnet-deployer-new

# 5. Delete the old key from local stellar config (after confirming new one works)
stellar keys rm testnet-deployer

# 6. Announce rotation in #deployments Slack channel
# Record in deployment log: "Testnet deployer key rotated, valid from 2026-09-26"
```

**Emergency rotation (key compromise suspected):**

1. Immediately update `STELLAR_TESTNET_DEPLOYER_SECRET` in GitHub to a new key.
2. Follow quarterly rotation steps above.
3. Audit all testnet deployments since last rotation (check Stellar testnet activity for the old key).
4. Create an incident issue if any unauthorized deployments are found.

---

## 3. Mainnet Secret Custody

### Production requirement

**Mainnet secrets must NOT be stored in GitHub Actions or any CI-accessible location.** Production deployments require human-initiated execution with secrets retrieved from an external vault at deploy time.

### Approved custody models

Choose one of the following for your mainnet deployment:

#### Option A: Hardware Security Module (HSM) or hardware wallet

**Best practice for high-value deployments.**

- **Setup:** Mainnet deployer key stored in a hardware wallet (e.g., Ledger, Trezor) or HSM.
- **Deploy procedure:**
  ```bash
  # On a secure, isolated machine (not in CI):
  export STELLAR_ACCOUNT=mainnet-deployer  # pre-configured to use HSM/wallet
  make deploy-mainnet  # will prompt for hardware unlock/PIN as needed
  ```
- **Custody:** Physical device in secure location (e.g., safe, office secured area); access log maintained.
- **Audit:** Deployment transactions signed by hardware device; all signatures are public on mainnet ledger.
- **Rotation:** Generate new key on hardware device; fund new account; retire old account (can be done on-chain via governance).

#### Option B: Vault (HashiCorp Vault, AWS Secrets Manager, etc.)

**Good for organizations with existing vault infrastructure.**

- **Setup:** Mainnet deployer key stored in vault with RBAC and audit logging.
- **Deploy procedure:**
  ```bash
  export STELLAR_MAINNET_DEPLOYER_SECRET=$(vault kv get -field=secret_key secret/mainnet-deployer)
  export MAINNET_USDC_SAC=$(vault kv get -field=usdc_sac_contract secret/mainnet-params)
  CONFIRM="DEPLOY TO MAINNET" make deploy-mainnet
  ```
- **Custody:** Vault access logs; only Release lead and designated backup can retrieve secret.
- **Audit:** Vault generates audit log of who retrieved the secret, when, and what was accessed.
- **Rotation:** Vault rotates secret; old secret automatically invalidated.

#### Option C: Air-gapped signing server

**For very high-security deployments.**

- **Setup:** Signing server isolated from network; receives deployment requests via USB stick or limited API.
- **Deploy procedure:**
  1. Build and sign locally: `stellar contract upload --dry-run`.
  2. Transfer unsigned txn to air-gapped server (USB stick).
  3. Server signs and returns signed txn (USB stick).
  4. Operator submits signed txn from connected machine.
- **Custody:** Server in physically secured location; all keys never touch the internet.
- **Audit:** Signing server logs all key operations; all signed transactions are on mainnet ledger.
- **Rotation:** Signing server rotates key internally; no network exposure needed.

### Custody requirements for all models

1. **Access control:** Only Release lead and designated emergency backup can approve a mainnet deployment.
2. **Dual authorization:** Two signers required for any key rotation or secret retrieval (implementable at vault or HSM level).
3. **Audit logging:** All key retrievals, deployments, and rotations logged with timestamp and actor name.
4. **Key material never in CI:** GitHub Actions, CI logs, or repositories must never contain mainnet secret keys.
5. **Rotation schedule:** Mainnet deployer key rotated annually or immediately on suspected compromise.

### Secret components for mainnet

| Secret | Usage | Storage | Rotation |
|--------|-------|---------|----------|
| `STELLAR_MAINNET_DEPLOYER_SECRET` | Deploy all contracts | HSM / Vault / Air-gapped | Annual or on compromise |
| `MAINNET_USDC_SAC` | Constructor arg (public, not secret) | Vault / config file | Never (constant for SAC) |
| Admin multisig keys | Governance (not deployment) | Separate custody | Per Access Control policy |
| Signing keys (notifications, oracle) | Off-chain signing | Separate vault | Per component procedures |

---

## 4. Incident response: Secret compromise

### Suspected secret exposure (testnet)

1. **Immediate:** Revoke the exposed secret in GitHub Actions.
2. **Same day:** Generate and fund a new testnet deployer key (see [Rotation procedure](#rotation-procedure)).
3. **24 hours:** Audit Stellar testnet activity for the old key; check for unauthorized deployments.
4. **Follow-up:** Document in a postmortem if any unauthorized activity found; adjust security procedures.

### Suspected secret exposure (mainnet)

1. **Immediate:** Page the Release lead and Security lead.
2. **Within 1 hour:** Revoke access to the exposed secret in vault/HSM.
3. **Within 4 hours:** Verify no unauthorized deployments made with the exposed key (check mainnet ledger).
4. **Within 24 hours:** Generate and fund a new mainnet deployer key; re-key any admin multisigs if the compromise is thought to be systemic.
5. **Communicate:** If user funds could be at risk, issue a security advisory per [SECURITY.md](../SECURITY.md).

See [incident-response-runbook.md](incident-response-runbook.md#6-response-by-incident-class) for the full incident response procedure.

---

## 5. Checklist: Pre-mainnet deployment

Before mainnet deployment, confirm:

- [ ] Testnet secret rotation procedure documented and rehearsed (this doc, §2).
- [ ] Mainnet custody model chosen and documented (HSM / Vault / Air-gapped, see §3).
- [ ] Mainnet secret generation, funding, and access control tested in rehearsal (dry run succeeds).
- [ ] Vault / HSM audit logging enabled and tested (verify a log entry is created on secret retrieval).
- [ ] Emergency backup release lead designated and can access mainnet secret.
- [ ] All core maintainers aware of custody procedures and their role in any emergency rotation.
- [ ] Incident response team (per [incident-response-runbook.md](incident-response-runbook.md)) trained on secret-exposure scenario.

---

## 6. Cross-references

| Document | Relevant section |
|----------|------------------|
| [incident-response-runbook.md](incident-response-runbook.md) | §6: Response to secret exposure |
| [mainnet-deployment-runbook.md](mainnet-deployment-runbook.md) | Step 2: Secret setup for mainnet deploy |
| [SECURITY.md](../SECURITY.md) | Security policy and incident reporting |
| [ci-cd.md](ci-cd.md) | Testnet CI workflow and secret setup |
