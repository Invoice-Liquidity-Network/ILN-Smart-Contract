# Reputation Model — Invoice Liquidity Network

## Overview

The reputation model is designed to reduce risk for liquidity providers (LPs) by tracking the historical behavior of participants in the network.

It assigns implicit credibility to:

* Payers (clients)
* Freelancers (invoice originators)

---

## Core Principles

### 1. Payer Reliability (Primary Risk Factor)

The most important signal in the system is:

> **Does the payer settle invoices on time?**

Each payer accumulates:

* Total invoices paid
* Total invoices defaulted
* Average payment delay

#### Derived Score

```
payer_score = paid_invoices / total_invoices
```

Enhancements:

* Time-weighted scoring
* Penalty for defaults
* Bonus for early payments

---

### 2. Freelancer Credibility

Freelancers are evaluated based on:

* % of invoices successfully funded
* % of invoices that defaulted
* Historical volume

This prevents:

* Fake invoices
* Low-quality counterparties

---

### 3. LP Risk Assessment

LPs use both scores:

```
risk = f(payer_score, freelancer_score, discount_rate)
```

Where:

* Higher discount_rate = higher perceived risk
* Lower payer_score = higher risk

---

## On-Chain vs Off-Chain

### On-Chain (Current Contract)

* Invoice lifecycle (Pending → Funded → Paid / Defaulted)
* Payment history
* Default events

### Off-Chain (Recommended)

* Score computation
* Risk dashboards
* LP decision engines

---

## Future Extensions

* NFT-based reputation badges
* Credit delegation
* Dynamic discount pricing based on score
* ZK-based private credit scoring

---

## Why This Matters

Without reputation:

* LPs cannot price risk
* Capital becomes inefficient
* Defaults increase

With reputation:

* Better pricing
* More liquidity
* Scalable credit markets

---

## Summary

The ILN reputation model transforms raw invoice data into:

> **Programmable creditworthiness**

This is the foundation for decentralized invoice financing at scale.
