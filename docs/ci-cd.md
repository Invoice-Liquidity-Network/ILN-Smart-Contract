# CI/CD Guide

This document describes how automated testnet deployment works and how to set up the deployer secret.

## Testnet Deployment Workflow

The workflow at `.github/workflows/deploy-testnet.yml` deploys all contracts to Stellar testnet on each push to `main`, then updates README contract IDs.

### What it does

- Builds optimized WASM for all contracts.
- Deploys to Stellar testnet using a dedicated deployer account.
- Updates the README testnet contract IDs table.
- Pushes README updates back to `main` with a `[skip ci]` commit message.
- Exposes a deployment summary as a workflow output.

## Required Secrets

Create a deployer keypair and store the secret key as a GitHub Actions secret.

1. Create a testnet deployer key:
   ```bash
   stellar keys generate --global iln-testnet-deployer
   stellar keys address iln-testnet-deployer
   ```
2. Fund the account:
   ```bash
   stellar network fund iln-testnet-deployer --network testnet
   ```
3. Add the secret to GitHub:
   - Settings -> Secrets and variables -> Actions -> New repository secret
   - Name: `STELLAR_TESTNET_DEPLOYER_SECRET`
   - Value: the secret key from `stellar keys secret iln-testnet-deployer`

## Notes

- Use a dedicated deployer account for automation only.
- Rotate the deployer key periodically and update the secret.
- If the workflow fails to deploy, check Stellar testnet status and rerun the job.
