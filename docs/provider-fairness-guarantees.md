# Provider Fairness Guarantees: Reputation-Weighted Priority Queue

## 1. Executive Summary & Objective

In decentralized invoice financing on the Invoice Liquidity Network (ILN), multiple Liquidity Providers (LPs) frequently compete to fund high-reputation, low-risk invoices. Without formal ordering guarantees, funding access is susceptible to:
1. **Mempool Front-Running (MEV)**: High-speed bots observing pending transactions and bribing validators to fund profitable invoices first.
2. **First-Come-First-Served (FCFS) Exploitation**: Latency advantages allowing co-located servers to starve regional LPs.
3. **Sybil & Cartel Manipulation**: Splitting capital across multiple fresh accounts to manipulate queue position.

To address these economic risks (grounded in `contracts/invoice_liquidity/src/lib.rs:2435-2530`), ILN implements an on-chain, reputation-weighted queue with cryptographic tie-breaking.

---

## 2. Core Architectural Guarantees

### 2.1 Monotonic Ledger-Sequence Maturity Window (`QUEUE_DELAY_LEDGERS`)
- When the first LP joins the queue for `invoice_id`, `FundQueueOpenedAt` records the current ledger sequence.
- `resolve_fund_queue` cannot be invoked until `current_ledger >= opened_at + QUEUE_DELAY_LEDGERS`.
- **Fail-Closed Policy**: If `FundQueueOpenedAt` is absent, corrupted, or archived, the contract explicitly returns `ContractError::QueueStateArchived` rather than resolving immediately.
- **Auditing Event**: Attempted premature resolutions publish `FundQueueResolutionAttempted` containing `attempted_at_ledger` to allow off-chain observability of MEV searchers.

### 2.2 Reputation-Weighted Ranking
- Queue entries are sorted in descending order of LP reputation score (`lp_score`).
- New providers start at neutral reputation (50 points).
- Successful repayments increment provider reputation; disputes or defaults reduce it.

### 2.3 Uniform Anti-FCFS Tie-Breaking
- If multiple LPs hold the identical highest reputation score, FCFS ordering is strictly prohibited.
- The contract identifies the contiguous prefix `queue[0..tied_count]` of matching top scores.
- The winning funder is selected uniformly at random using Soroban's network-seeded pseudo-random number generator (`env.prng().gen_range(0..tied_count)`).
- Bounded execution is guaranteed: worst-case scan is capped by `MAX_FUND_QUEUE_LEN` ($O(N)$ with $N \le 10$).

---

## 3. Threat Model & Failure Mode Matrix

| Threat Vector | Mitigation Mechanism | Contract Invariant |
| :--- | :--- | :--- |
| **Searcher Front-Running** | `QUEUE_DELAY_LEDGERS` delay | Resolves fail with `QueueNotMature` before delay |
| **Zero-Latency Monopolization** | Uniform PRNG tie-breaking | All top-tied providers have equal $1/K$ probability |
| **Archival Race / TTL Loss** | Fail-closed state validation | Returns `QueueStateArchived` if state missing |
| **Unapproved Funder Race** | Funder exclusivity lock | Only winning approved LP may invoke `fund_invoice` |

---

## 4. Verification & Audit Trail
All fairness constraints are continuously tested in:
- `contracts/invoice_liquidity/src/tests_lp_priority_queue.rs`
- `scripts/verify-provider-fairness.ts`
