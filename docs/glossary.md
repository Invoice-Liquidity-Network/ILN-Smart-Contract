# Glossary

Protocol terminology used across ILN docs, contracts, SDK, and services.

## Basis Points (bps)

A basis point is one hundredth of one percent, so `100 bps` equals `1%`. ILN uses basis points for discount-rate precision; see [ADR-003](adr/ADR-003-discount-rate-basis-points.md).

## Circuit Breaker

A circuit breaker temporarily stops risky or repeatedly failing operations so the system can recover or wait for review. ILN uses the concept in governance and notifications delivery; see [Governance](governance.md) and [notifications README](../notifications/README.md).

## Discount Rate

The discount rate is the percentage of invoice face value the submitter gives up in exchange for early liquidity. It is represented in basis points; see [ADR-003](adr/ADR-003-discount-rate-basis-points.md) and the [Contract ABI](contract-abi.md).

## Effective Yield

Effective yield is the LP's realized return after accounting for the funded amount, discount, and time until settlement. SDK funding helpers expose effective-yield values; see [SDK Integration](sdk-integration.md).

## HMAC

HMAC is a keyed message authentication code used to prove a webhook payload came from a holder of the shared secret. The notifications service signs webhook payloads with HMAC-SHA256; see [notifications README](../notifications/README.md).

## Horizon

Horizon is Stellar's HTTP API for account, ledger, operation, and historical network data. ILN clients use Stellar RPC for Soroban contract simulation/submission and may use Horizon for account or event-adjacent workflows; see [SDK Integration](sdk-integration.md).

## Invoice Factoring

Invoice factoring lets a business sell or finance an unpaid invoice before the payer settles it. ILN implements a blockchain-native factoring flow where submitters receive early liquidity and LPs earn the invoice discount; see [Architecture](Architecture.md).

## Ledger

A ledger is Stellar's ordered unit of consensus state, similar to a block in other chains. Local development health checks verify the local Stellar quickstart node by reading the current ledger; see [Local Development](local-development.md).

## Liquidity Provider (LP)

A liquidity provider funds submitted invoices and earns yield when the payer settles. LP actions are part of the core invoice lifecycle in [Architecture](Architecture.md) and [First Invoice Tutorial](tutorials/first-invoice.md).

## Payer

The payer is the customer or counterparty responsible for paying the invoice. In ILN flows, the payer settles the funded invoice on-chain; see [Architecture](Architecture.md).

## Quorum

Quorum is the minimum voting participation required for a governance proposal to be valid. ILN governance uses quorum with timelocks and proposal lifecycle rules; see [Governance](governance.md) and [ADR-005](adr/ADR-005-governance-timelock.md).

## Reputation Score

Reputation score summarizes historical submitter behavior such as paid, defaulted, and submitted invoices. It informs protocol risk and discounts; see [Reputation](reputation.md) and [Reputation Model](reputation-model.md).

## Settlement

Settlement is the final payment step where funds move according to the invoice state machine, usually from payer to LP after funding. Settlement behavior is described in [Architecture](Architecture.md) and [Contract ABI](contract-abi.md).

## Soroban

Soroban is Stellar's smart contract platform and runtime. ILN contracts are Soroban contracts compiled to WASM; see [ADR-001](adr/ADR-001-soroban-chain-choice.md).

## Stellar Asset Contract (SAC)

A Stellar Asset Contract wraps a classic Stellar asset, such as USDC or XLM, for use by Soroban contracts. ILN supports multiple token contracts; see [Multi-Token Support](multi-token.md).

## Submitter

The submitter is the freelancer, business, or integrator that submits an invoice to the protocol for funding. Submitter actions are shown in the [First Invoice Tutorial](tutorials/first-invoice.md).

## Timelock

A timelock enforces a delay before a governance-approved action can execute. ILN uses timelocks to give maintainers and users time to inspect sensitive changes; see [ADR-005](adr/ADR-005-governance-timelock.md).

## Trustline

A trustline is a Stellar account's explicit opt-in to hold a non-native Stellar asset. Integrations using issued assets such as USDC need the relevant trustline before transferring tokens; see [Multi-Token Support](multi-token.md).

## XDR

XDR is Stellar's canonical binary serialization format for transactions, operations, and contract values. The SDK handles XDR construction and parsing for ILN contract calls; see [SDK README](../sdk/README.md).

## Yield

Yield is the LP's return for supplying liquidity to an invoice. In ILN, yield generally comes from the invoice discount captured when the payer settles; see [Architecture](Architecture.md).
