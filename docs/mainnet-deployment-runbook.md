# Mainnet Deployment Runbook

This is the mainnet-specific deployment procedure referenced by the
[Mainnet Launch Checklist](mainnet-launch-checklist.md) ("Mainnet deployment runbook").
`scripts/deploy.ts` and `scripts/deploy-testnet.sh` cover testnet; this document plus
[`scripts/deploy-mainnet.sh`](../scripts/deploy-mainnet.sh) are the mainnet equivalent
(Issue #648).

Every step below either has a `--dry-run` mode or is a read-only check, so the whole
procedure can — and must — be rehearsed before it is run for real.

## Prerequisites

- [ ] External security audit complete (see [Mainnet Launch Checklist](mainnet-launch-checklist.md))
- [ ] Multi-sig admin account configured (see [Access Control](access-control.md))
- [ ] Mainnet deployer account created and funded with enough XLM to cover four
      contract uploads + deploys (20 XLM is a safe working minimum; mainnet has no
      friendbot, so this is a manual transfer)
- [ ] `STELLAR_MAINNET_DEPLOYER_SECRET` available to whoever runs the deploy (not
      committed anywhere — pull from your secret manager for the duration of the run)
- [ ] Mainnet USDC SAC contract address confirmed and exported as `MAINNET_USDC_SAC`
- [ ] `.contracts-mainnet.env` passes the config drift check (see below) once it exists
- [ ] Release lead and one additional maintainer both present for the live run

## Config drift check (testnet vs. mainnet)

Once `.contracts-mainnet.env` exists, run
[`scripts/check-env-config-drift.ts`](../scripts/check-env-config-drift.ts) before
deploying:

```bash
npx tsx scripts/check-env-config-drift.ts
```

This catches the class of bug where `.contracts-testnet.env` and
`.contracts-mainnet.env` silently diverge — a missing key, a `NETWORK=` value that
doesn't match the file it's in, or a value (contract ID, admin address, tunable
constant) that was copy-pasted between networks and never updated for mainnet. It
also runs in CI on every change to either env file — see
[Env Config Drift Check](../.github/workflows/env-config-drift-check.yml).

## Step 1 — Dry run

Rehearse the full procedure with no transactions submitted:

```bash
make deploy-mainnet-dry-run
# equivalent to: bash scripts/deploy-mainnet.sh --dry-run
```

This runs every pre-flight check (network config, deployer balance, WASM size budget)
and prints the exact `stellar contract upload` / `stellar contract deploy` commands it
would run for each of the four core contracts, without contacting mainnet.

**Dry-run record (2026-08-29):** `scripts/deploy-mainnet.sh --dry-run` was executed to
confirm control flow. Steps 1–2 (network configuration, deployer account/balance)
correctly detect a missing `stellar` CLI / unconfigured network and print the
`(dry-run)` skip messages shown below instead of aborting or attempting a live call:

```
=== ILN Mainnet Deploy ===
Mode: DRY-RUN

[1/5] Checking network configuration...
  (dry-run) Would add network 'mainnet' — not configured yet.

[2/5] Checking deployer account...
  (dry-run) Deployer key 'mainnet-deployer' does not exist yet — would need to be added from STELLAR_MAINNET_DEPLOYER_SECRET.
  (dry-run) Would check 'mainnet-deployer' balance >= 20 XLM.

[3/5] Building optimized WASM...
```

Step 3 onward requires the Rust toolchain and the `stellar` CLI, which is why this
runbook requires a full rehearsal (with both installed, network configured, and a
funded deployer) as a release gate before the first real mainnet deploy — see the
sign-off checklist at the bottom of this document.

## Step 2 — Live deployment

Only after a clean full dry run (steps 1–5, all four contracts, on a machine with the
Rust toolchain and Stellar CLI installed) and required sign-offs:

```bash
export STELLAR_MAINNET_DEPLOYER_SECRET="S..."
export MAINNET_USDC_SAC="C..."
CONFIRM="DEPLOY TO MAINNET" make deploy-mainnet
```

`scripts/deploy-mainnet.sh` refuses to submit any transaction unless `CONFIRM` matches
that exact phrase — this is a deliberate typo-resistant confirmation gate, not a
formality to skip past.

The script builds and shrinks WASM for `invoice_liquidity`, `iln_governance`,
`iln_distribution`, and `reputation_bonus`, uploads and deploys each in turn, and
writes `.contracts-mainnet.env` and `deploy-summary-mainnet.json`.

## Step 3 — Insurance pool (separate contract)

```bash
INSURANCE_POOL_ADMIN="<invoice_liquidity contract ID>" \
INSURANCE_POOL_COVERAGE="<coverage in stroops>" \
bash scripts/deploy-insurance-pool.sh mainnet mainnet-deployer
```

`INSURANCE_POOL_ADMIN` should be the deployed `invoice_liquidity` contract address so
only it can file claims in production (see [Access Control](access-control.md)).

## Step 4 — Verify

```bash
make verify-mainnet
# equivalent to: NETWORK=mainnet npx tsx scripts/verify-deployment.ts
```

This is the dedicated mainnet verification pass from Issue #649: it checks the
network/passphrase configuration is actually mainnet, that each contract's on-chain
WASM hash matches the artifact just built, and — when `EXPECTED_USDC_TOKEN` /
`EXPECTED_INSURANCE_TOKEN` / etc. are set to the addresses used above — that the
constructor arguments landed correctly. It writes `verification-report.mainnet.json`
and exits non-zero on any failure.

**Do not proceed to Step 5 unless this exits 0.**

## Step 5 — Publish

```bash
MAINNET_USDC_SAC="C..." make publish-mainnet
# equivalent to: bash scripts/publish-mainnet-contracts.sh
```

Reads `.contracts-mainnet.env`, requires `verification-report.mainnet.json` to show
`allPassed: true`, validates every address against the Stellar strkey contract-address
shape, and writes the "Mainnet Contract Addresses" table in the root
[README.md](../README.md). This is the automation from Issue #650 — there is no
manual copy/paste step between a deployment and what gets published.

## Rollback

Soroban contract deploys are not reversible on their own, but nothing is
user-facing until the contract addresses are published in Step 5. If verification
(Step 4) fails:

1. Do **not** run Step 5.
2. Leave the failing contract's address out of any external communication.
3. If the failure is a bad constructor arg (wrong token address, wrong coverage),
   redeploy that single contract following the [Upgrade Guide](upgrade-guide.md)'s
   pre-upgrade validation steps, or restart from Step 2 for that contract only.
4. Record the failure and resolution in the deployment summary before re-attempting.

## Sign-off

Mainnet deployment requires:

- [ ] Release lead confirms a clean dry run (Step 1) on a machine with the full
      toolchain installed
- [ ] Release lead + one additional maintainer present for the live run (Step 2)
- [ ] `make verify-mainnet` (Step 4) exits 0 before `make publish-mainnet` is run
- [ ] Updated [Mainnet Launch Checklist](mainnet-launch-checklist.md) row: "Mainnet
      deployment runbook" → Complete once the above has happened for real
