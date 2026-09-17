# Access Control Matrix

## 1. Overview

The ILN-Smart-Contract implements a centralized access-control architecture to guarantee that all protocol operations are properly authorized. By centralizing permissions into shared guards, we achieve:
- **Consistency**: All similar checks behave exactly the same way across different endpoints.
- **Audibility**: Clear, easily reviewable access annotations on every public instruction.
- **Maintainability**: Reduced code duplication by eliminating inline authorization checks.

Security goals include enforcing the principle of least privilege, preventing unauthorized state mutations, and ensuring that any authorization failure immediately returns a deterministic contract error.

## 2. Role Definitions

### Submitter
Represents a freelancer or service provider who submits invoices to the protocol.
- **Can**: Create invoices, update invoices before funding, cancel un-funded invoices, and transfer invoice ownership.
- **Cannot**: Modify another user's invoice, force funding, or alter protocol configuration.

### Payer
The client who owes payment on the submitted invoice.
- **Can**: Pay the invoice (mark paid), file an appeal if a default occurs unfairly.
- **Cannot**: Create an invoice on behalf of a submitter, modify invoice terms, or claim yields.

### LP (Liquidity Provider)
Entities providing liquidity to fund pending invoices.
- **Can**: Join funding queues, fund approved invoices, claim yields, and claim default refunds.
- **Cannot**: Approve themselves without queue resolution, modify invoice terms, or appeal a default.

### Admin
The protocol administrator.
- **Can**: Update fee rates, maximum discount rates, distribution contracts, manage allowed tokens, pause/unpause the protocol, and resolve default appeals.
- **Cannot**: Arbitrarily modify invoice ownership, submit invoices as users without explicit authorization, or drain funds.

### Governance
Reserved for future DAO or multisig control over core parameter changes. Currently delegates to Admin functionality.

### Insurance Pool Admin
Authorized to process default claims against the insurance pool (typically the liquidity contract).
- **Can**: File claims on behalf of defaulted invoices, trigger compensation payouts, and query pool state.
- **Cannot**: Modify enrollment, adjust premium rates, or drain the pool directly.

### Anyone
Publicly accessible read or state-transition functions that do not require specific authorization.
- **Can**: Read contract stats, query scores, resolve fund queues, and expire timed-out invoices.

## 3. Instruction Permission Matrix

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `initialize` | Anyone | Initializes the contract once |
| `set_admin` | Admin | Updates the contract administrator address |
| `update_fee_rate` | Admin | Sets the protocol fee rate |
| `update_max_discount` | Admin | Updates the maximum allowed discount rate |
| `set_distribution_contract`| Admin | Updates the distribution contract address |
| `add_token` | Admin | Adds a supported token to the protocol |
| `remove_token` | Admin | Removes a supported token |
| `pause` | Admin | Pauses the protocol for emergency |
| `unpause` | Admin | Resumes protocol operations |
| `get_contract_stats` | Anyone | Reads protocol statistics |
| `submit_invoice` | Submitter | Submits a new invoice |
| `update_invoice` | Submitter | Updates an existing un-funded invoice |
| `submit_invoices_batch` | Submitter | Submits multiple invoices |
| `join_fund_queue` | LP | Enqueues intent to fund an invoice |
| `resolve_fund_queue` | Anyone | Selects the LP with highest reputation |
| `fund_invoice` | LP | Funds a pending invoice |
| `transfer_invoice` | Submitter | Transfers ownership of an invoice |
| `cancel_invoice` | Submitter | Cancels an un-funded invoice |
| `expire_invoice` | Anyone | Marks a pending expired invoice as Expired |
| `mark_paid` | Payer | Pays off an invoice |
| `claim_yield` | LP | Claims yield for a paid invoice |
| `claim_default` | LP | Claims refund for a defaulted invoice |
| `appeal_default` | Payer | Appeals an unfair default |
| `resolve_appeal` | Admin | Approves or rejects a default appeal |
| `payer_score` | Anyone | Reads a payer's reputation score |
| `lp_score` | Anyone | Reads an LP's reputation score |
| `suggested_discount_rate` | Anyone | Calculates discount rate based on score |
| `get_invoice` | Anyone | Reads invoice details |
| `get_invoice_count` | Anyone | Reads total invoice count |
| `insurance_pool_enroll` | LP | Opts into default-protection insurance |
| `insurance_pool_deposit_premium` | LP | Pays premium to pool (auto-enrolls) |
| `insurance_pool_claim` | Insurance Pool Admin | Files a claim for a defaulted invoice |
| `insurance_pool_get_balance` | Anyone | Reads current pool balance |
| `insurance_pool_get_coverage` | Anyone | Reads per-claim coverage cap |
| `insurance_pool_is_enrolled` | Anyone | Checks LP enrollment status |
| `insurance_pool_get_premiums_paid` | Anyone | Reads cumulative premiums by LP |

## 4. Insurance Pool Access Control

The insurance pool operates as a separate contract with its own authorization model:

- **Pool Enrollment**: LPs call `enroll()` or implicitly auto-enroll on first premium deposit.
- **Premium Deposits**: Any LP can call `deposit_premium()` to add funds to the pool (requires LP signature).
- **Claims**: Only the configured pool admin (the liquidity contract in production) can call `claim()` to trigger compensation for a confirmed default.
- **Queries**: Pool state (balance, coverage, enrollment, premiums) is publicly readable to support analytics and integrations.

This isolation ensures that the insurance pool cannot be drained except through claims authorized by the main contract, and that no single LP can block others from withdrawing coverage.

### Additional Admin Functions (Dispute Resolution)

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `resolve_appeal` | Admin | Approves or rejects a default appeal (must call `require_admin`) |
| `resolve_dispute` | Admin | Resolves a dispute on an invoice |
| `auto_resolve_dispute` | Anyone | Auto-resolves a dispute after timeout elapsed |
| `set_min_payer_reputation` | Admin | Sets minimum payer reputation threshold |
| `set_price_oracle` | Admin | Updates the price oracle address |
| `set_max_oracle_age` | Admin | Updates the maximum oracle age |
| `upgrade` | Admin | Emits upgrade event for WASM hash change |
| `update_config` | Admin | Updates reputation and token configuration |

### Governance Contract Admin Functions

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `set_execution_delay` | Admin | Sets timelock delay for proposal execution |
| `veto_proposal` | Admin | Vetoes an active/passed proposal |
| `set_min_quorum_bps` | ILN Contract | Updates quorum threshold |
| `set_min_proposal_balance` | ILN Contract | Updates minimum proposer balance |
| `disable_veto_power` | ILN Contract | Permanently disables admin veto |

### Insurance Pool Contract Admin Functions

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `claim` | Admin (liquidity contract) | Files a claim for defaulted invoice |

## 5. Audit Findings (Issue #540)

The following findings were identified and resolved during the access control audit:

### Finding AC-01: Missing `require_admin` in `resolve_appeal`
- **Severity:** High
- **Location:** `contracts/invoice_liquidity/src/lib.rs:resolve_appeal`
- **Description:** The function lacked an explicit `require_admin` guard. Although only the payer of the specific invoice could trigger appeals, the resolution function could be called by anyone, allowing unauthorized state transitions from `Appealed` to `Defaulted`.
- **Resolution:** Added `require_admin(&env)?;` as the first statement in the function body.
- **Commit:** This commit.

### Finding AC-02: All other admin functions properly guarded
- All admin-privileged functions in the Invoice Liquidity, Insurance Pool, and Governance contracts include explicit authorization checks at entry. No additional missing guards were found.

## 6. Rate Limiting Design (Issue #541)

### Rationale

Certain admin operations are sensitive to high-frequency invocation — an attacker who compromises an admin key could rapidly toggle economic parameters to extract value or disrupt protocol operations. Rate limiting introduces a time-based cooldown between successive calls to mitigate this risk.

### Functions with Rate Limiting

| Function | Cooldown | Rationale |
|---|---|---|
| `set_admin` | 720 ledgers (~1h) | Admin key rotation must be slow to allow detection |
| `upgrade` | 1440 ledgers (~2h) | Contract upgrade is the most sensitive operation |
| `update_fee_rate` | 360 ledgers (~30min) | Economic parameter manipulation |
| `update_max_discount` | 360 ledgers (~30min) | Economic parameter manipulation |
| `set_min_payer_reputation` | 360 ledgers (~30min) | Economic parameter manipulation |
| `set_distribution_contract` | 120 ledgers (~10min) | Infrastructure change |
| `set_price_oracle` | 120 ledgers (~10min) | Infrastructure change |
| `set_max_oracle_age` | 120 ledgers (~10min) | Infrastructure change |
| `add_token` | 120 ledgers (~10min) | Token allowlist change |
| `remove_token` | 120 ledgers (~10min) | Token allowlist change |

### Exempt Functions

Emergency functions are not rate-limited so they can be used immediately when a threat is detected:
- `pause`
- `unpause`
- `resolve_appeal`
- `resolve_dispute`

### Implementation

Rate limiting is implemented in `contracts/invoice_liquidity/src/access.rs`:

- `check_rate_limit(env, fn_name, cooldown_ledgers)` checks the last ledger when the function was called. If insufficient ledgers have elapsed, it returns `ContractError::RateLimited`. Otherwise, it records the current ledger as the last call time.
- Storage key: `DataKey::RateLimit(Symbol::new(env, fn_name))` — per-function, instance storage.
- The cooldown is measured in ledgers (not timestamps) to align with Soroban's deterministic execution model.
- At ~5 seconds per ledger: 120 ledgers ≈ 10 min, 360 ≈ 30 min, 720 ≈ 1h, 1440 ≈ 2h.

### Audit Finding RL-01

- **Severity:** Medium
- **Finding:** Several admin functions (`update_fee_rate`, `set_admin`, `upgrade`, etc.) lacked any rate-limiting mechanism, allowing rapid successive calls that could be used to grief the protocol or confuse indexers.
- **Resolution:** Added `check_rate_limit` guard to all sensitive admin functions with appropriate cooldown periods.

## 7. Security Notes
## 5. Security Notes

- **Principle of Least Privilege**: Each instruction relies only on the minimal authority required to execute.
- **Centralized Verification**: Extracted inline logic ensures uniform verification logic and robust testing.
- **Auditability Improvements**: Every guard clearly emits a deterministic `Unauthorized` error instead of panicking, enhancing tracing.
- **Rejection Behavior**: If authorization fails, the protocol safely rejects the mutation without consuming extra gas or altering contract state.
