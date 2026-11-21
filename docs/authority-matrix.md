# Authority Matrix

**Issue:** #1161 · **Owner:** Security lead ([incident-response-runbook.md](incident-response-runbook.md)) · **Companion:** [custody-and-payout-matrix.md](custody-and-payout-matrix.md)

Every privileged operation in the ILN contracts, with who may call it, what must already be true on-chain, any delay or rate limit, and what to do when it goes wrong. Gates were read from the function bodies, including helpers such as `require_submitter_by_id` and `oracle_registry::*`, and were not inferred from names. Where this file and [access-control-matrix.generated.md](access-control-matrix.generated.md) disagree, the generated file is wrong for helper-gated functions (it labels `cancel_invoice`, `add_price_source`, `register_oracle` and others as "Anyone").

## 1. Authority model

| Authority | Held by | How it authenticates | How it changes |
|-----------|---------|----------------------|----------------|
| **ILN admin** | One `Address` in `DataKey::Admin`: an EOA, a Stellar account-level multisig, or the governance contract after the [ADR-012](adr/ADR-012-governance-multisig-handoff.md) handoff | `require_admin` → `admin.require_auth()` | `set_admin`: single step, rate-limited |
| **ILN contract-level multisig** | `MultisigAdmin { signers, threshold }` | each signer's `require_auth()`; only approvals from *current* signers count | `UpdateMultisig` or `RotateSigner` proposals |
| **Governance** | Governance-token holders (vote) and veto signers (block) | `cast_vote` balance checkpoints; `veto_proposal` signer set | Proposals; veto config via the governance admin or the ILN address |
| **Governance admin** | `iln_governance` `StorageKey::Admin` | `admin.require_auth()` + equality check | No rotation entry point |
| **Insurance admin** | `insurance_pool` `DataKey::Admin`: the ILN contract in production | `admin.require_auth()` | `propose_admin_transfer` → 3-day timelock → `execute_admin_transfer` |
| **Distribution authority** | The ILN address bound at `initialize` | `iln_contract.require_auth()` | Immutable |

**Upgradeability.** Only `invoice_liquidity` can be upgraded, through Soroban in-place WASM replacement (`env.deployer().update_current_contract_wasm`) in `upgrade`. It is **not** a proxy: the contract address, storage and balances stay the same and only the code changes. `iln_governance`, `insurance_pool`, `iln_distribution` and `reputation_bonus` have no upgrade entry point and can only be replaced by redeploying and re-wiring.

## 2. Matrix

Delays are in ledgers (about 5 s each). "Rate limit" is the per-function cooldown enforced by `check_rate_limit`. Every direct-admin row is covered by `every_direct_admin_entrypoint_rejects_an_imposter` (`tests_authority_matrix.rs`) unless another test is named.

### 2.1 `invoice_liquidity`: admin, protocol and emergency

| Operation | Caller | On-chain prerequisites | Delay / rate limit | Rollback / emergency | Tests |
|-----------|--------|------------------------|--------------------|----------------------|-------|
| `set_admin` | admin | — | 720 | Single step; no undo if mistyped (F-09). New admin can `set_admin` back after the cooldown. | `rotated_out_admin_loses_every_privilege`, `admin_rotation_is_rate_limited` |
| `pause` / `unpause` | admin | — | none (intentional) | Idempotent; `unpause` reverses | `repeated_pause_and_unpause_are_idempotent`, `pause_blocks_every_token_moving_entrypoint` |
| `upgrade(wasm_hash)` | admin | WASM uploaded; no sampled persistent entry below `TTL_MIN_LEDGERS_BEFORE_UPGRADE` | 1 440 | Upgrade again to the previous hash ([mainnet-rollback-runbook.md](mainnet-rollback-runbook.md)); run `rehearse_rollback` first. A failed upgrade changes nothing. | `failed_upgrade_leaves_contract_state_untouched` |
| `migrate` | admin | stored version < `CURRENT_STORAGE_VERSION` | none (one-shot, version-gated) | No-op at the current version | `migrate_is_idempotent_at_the_current_version` |
| `rehearse_rollback` | admin | — | none | Read-only check plus audit event | imposter row |
| `initialize` | deployer (no caller check) | — | — | Initialize in the deployment transaction ([init-authority-audit.md](init-authority-audit.md)) | — |
| `update_config` | `caller` **must equal** admin (explicit argument) | bounds in `config.rs` | 360 | Re-run with previous values | `update_config_rejects_a_caller_who_is_not_admin`, `tests_config_parameter_bounds` |

### 2.2 `invoice_liquidity`: fees and economic parameters

| Operation | Caller | Prerequisites | Delay / rate limit | Rollback | Tests |
|-----------|--------|---------------|--------------------|----------|-------|
| `update_fee_rate` | admin | `rate ≤ 10 000` | 360 | Set the previous rate | `fee_rate_above_one_hundred_percent_is_rejected_on_every_path` |
| `update_fee_tiers` | admin | `≤ MAX_FEE_TIERS` tiers, each `≤ 10 000` | 360 | Set the previous tiers | same |
| `update_max_discount` | admin | `rate ≤ MAX_DISCOUNT_RATE` (5 000) | 360 | Set the previous value | `max_discount_cannot_exceed_the_submit_hard_cap` |
| `update_decay_params` | admin | bounds | 360 | Set the previous value | imposter row |
| `set_min_payer_reputation`, `set_max_invoice_amount`, `set_token_volume_cap` | admin | — | none | Set the previous value | imposter row |

### 2.3 `invoice_liquidity`: token allowlist, wiring and oracles

| Operation | Caller | Prerequisites | Delay / rate limit | Rollback | Tests |
|-----------|--------|---------------|--------------------|----------|-------|
| `add_token(token, decimals)` | admin | token answers `decimals()` (matches), SAC `authorized()`; contract and admin authorized | 120 | `remove_token` | `tests_token_safety` |
| `remove_token` | admin | — | 120 | `add_token` | imposter row |
| `correct_token_decimals` | admin | matches the token's `decimals()` | 120 | — | imposter row |
| `set_distribution_contract` | admin | — | **none** (F-11) | Set back; a reverting target blocks funding and settlement | imposter row |
| `set_insurance_pool` | admin | — | 120 | Set back; claims degrade gracefully (`try_`) | imposter row |
| `set_price_oracle`, `set_max_oracle_age` | admin | — | 120 | Set back | imposter row |
| `register_oracle`, `remove_oracle`, `register_token_oracle`, `remove_token_oracle` | admin | — | 120 | Register the vetted replacement ([oracle-provider-vetting.md](oracle-provider-vetting.md)) | imposter row |
| `add_price_source`, `remove_price_source`, `set_max_price_deviation_bps` | admin | `≤ MAX_PRICE_SOURCES_PER_FEED` | 120 | Remove the source | imposter row |
| `add_identity_oracle`, `remove_identity_oracle`, `set_identity_quorum` | admin | `≤ MAX_IDENTITY_ORACLES_PER_FEED`; quorum valid | 120 | — | imposter row |
| `reset_oracle_circuit` | admin | oracle confirmed healthy (operational) | 120 | — | imposter row |
| `set_twap_enabled`, `set_twap_window` | admin | window within bounds | 120 | — | `tests_oracle_registry` |

### 2.4 `invoice_liquidity`: dispute resolution (moves funds, see custody C4)

| Operation | Caller | Prerequisites | Delay | Rollback | Tests |
|-----------|--------|---------------|-------|----------|-------|
| `resolve_dispute(id, hash, 1\|2)` | admin | status `Disputed` | none | None once refunds are paid | `imposter_cannot_resolve_dispute_into_a_refund`, `upheld_dispute_on_partial_funding_refunds_exactly_once` |
| `resolve_appeal(id, upheld)` | admin | status `Appealed` | none | Reputation only | imposter row |
| `auto_resolve_dispute` | anyone | `dispute_timeout_ledgers` elapsed | timeout | Always resolves in the freelancer's favor | `tests_appeal` |

### 2.5 `invoice_liquidity`: contract-level multisig

| Operation | Caller | Prerequisites | Delay | Rollback / emergency | Tests |
|-----------|--------|---------------|-------|----------------------|-------|
| `initialize_multisig_admin` | admin, **once** | valid config (non-empty, no duplicates, `1 ≤ threshold ≤ n`) | — | Change only via `UpdateMultisig` | `multisig_bootstrap_is_one_shot` |
| `propose_*` | current signer (auto-approves) | no live duplicate proposal for the same action; parameter bounds for fee and discount | proposals expire after 17 280 | Let it expire | `non_signer_cannot_propose_sign_execute_or_touch_rotation`, `multisig_path_enforces_the_same_parameter_bounds_as_direct_admin` |
| `sign_proposal` | current signer | not expired, executed or already signed | — | — | `tests_multisig_admin` |
| `execute_proposal` | current signer | `threshold` approvals **from current signers**; not expired or executed | — | Re-propose the inverse action | `approvals_from_removed_signers_do_not_count` |
| `RotateSigner` → `finalize_signer_rotation` | threshold, then any current signer | rotation scheduled; 34 560-ledger timelock elapsed | 34 560 | `cancel_signer_rotation` (any single current signer) | `signer_rotation_respects_threshold_and_timelock` |

### 2.6 `iln_governance`

| Operation | Caller | Prerequisites | Delay | Rollback / emergency | Tests |
|-----------|--------|---------------|-------|----------------------|-------|
| `create_proposal` / `cast_vote` | token holder | proposer balance and deposit; vote checkpoint ≥ `MIN_VOTE_HOLD_LEDGERS` old | 259 200 s voting period | Veto | `test_cast_vote_*`, `test_deposit_*` (`iln_governance/src/test.rs`) |
| `execute_proposal` | anyone | quorum and majority; `eta_ledger` reached; not paused, vetoed or already executed | `ExecutionDelay` (≤ 518 400) | A failed cross-contract call leaves the proposal `Passed` for retry | `g2_governance_applies_a_change_only_after_vote_and_timelock`, `g3_governance_cannot_push_a_parameter_past_the_contract_bound` |
| `pause` / `unpause` | governance admin | initialized | none | Blocks `execute_proposal` only; cannot shorten a timelock | `g4_emergency_pause_holds_execution_without_shortening_the_timelock` |
| `set_execution_delay` | governance admin | `≤ MAX_EXECUTION_DELAY_LEDGERS`; ≥ the 24 h floor once veto is disabled; **cannot be lowered while a scheduled eta is pending** | — | Raise again | `g4_…`, `test_delay_reduction_blocked_while_proposals_scheduled` |
| `veto_proposal` | veto signer | proposal `Active`/`Passed`; same reason hash as earlier approvals | threshold of signers | Terminal | `x7_governance_veto_transition_safety`, `test.rs` veto tests |
| `configure_veto_multisig` | ILN address or governance admin | valid config | — | Reconfigure | `test.rs` |
| `disable_veto_power[_with_reason]` | the ILN address | veto still enabled | — | **Irreversible** | `test.rs` |
| `set_min_quorum_bps`, `set_max_delegation_depth`, `set_min_proposal_*`, `set_proposal_deposit_sink`, `set_quadratic_voting_enabled`, `set_gov_token_total_supply` | the ILN address | bounds | — | Set back | `test.rs` |
| `initialize` | anyone, **once** | — | — | Front-run window ([init-authority-audit.md](init-authority-audit.md)) | `test_double_initialize_rejected` |

Governance reaches ILN by invoking the ILN admin entry points above. That only works once the ILN admin **is** the governance contract, and the ILN-side bounds still apply (G3). Governance-to-insurance and governance-to-distribution actions currently cannot succeed (F-05, F-06).

### 2.7 `insurance_pool` and `iln_distribution`

| Operation | Caller | Prerequisites | Delay | Rollback | Tests |
|-----------|--------|---------------|-------|----------|-------|
| pool `claim` | pool admin | not already claimed; circuit closed; review window if enabled | optional review window | — | `only_the_admin_can_trigger_a_claim_payout`, `claim_is_idempotent_per_invoice` |
| pool `top_up_backstop`, `submit_claim_evidence`, `set_*` | pool admin | bounds | — | Set back | `only_the_admin_can_order_a_backstop_top_up`, `test.rs` |
| pool `propose_coverage_change` / `propose_risk_multiplier` / `propose_admin_transfer` → `execute_*` | pool admin → anyone | timelock elapsed | 3 days | `cancel_*` (admin) | `test.rs` |
| pool `reset_solvency_circuit` | pool admin | — | — | — | `test.rs` |
| distribution `accrue_*` | ILN address | — | — | — | `only_the_iln_contract_can_accrue_rewards` |
| distribution `set_*_reward_rate` | ILN address | **no bounds** (F-06) | — | Set back | `reward_rate_setters_accept_only_the_configured_iln_address` |

## 3. Path differences

The same effect can be reached through up to three paths. They are **not** equivalent:

| Property | Direct admin | Contract multisig | Governance |
|----------|--------------|-------------------|------------|
| Parameter bounds (fee, discount) | ✅ | ✅ at propose **and** execute | ✅ (enforced by ILN) |
| Rate limit / cooldown | ✅ | ❌ (F-08) | n/a (timelock instead) |
| `record_admin_action` audit log | ✅ | ❌ (F-08) | ILN logs the call |
| Vote + timelock + veto | ❌ | ❌ | ✅ |
| Actions available | all | pause, unpause, remove token, fee rate, max discount, signer set | the `ProposalAction` list |

So while the multisig and governance paths coexist, `threshold` multisig signers can pause, remove a token or change fees **without** a governance vote or timelock. This is the intended emergency path in [incident-response-runbook.md §4](incident-response-runbook.md#4-decision-authority-for-pause), but operators should treat multisig signers as fully trusted for those actions.

## 4. Emergency and recovery procedures

No self-remediation logic was added. Recovery is the documented manual actions below, owned by the named roles.

| Situation | Action | Who decides / signs | Runbook |
|-----------|--------|---------------------|---------|
| Suspected exploit (Critical) | `pause()`, or the multisig `propose_pause` path if the admin key is unavailable | IC authorizes; Release lead executes with the admin key; multisig signers A/B/C | [incident-response-runbook.md §4, §7](incident-response-runbook.md#4-decision-authority-for-pause) |
| Malicious governance proposal | `veto_proposal`; or governance `pause` to hold *all* execution | Veto signers; governance admin | [governance-security-summary.md](governance-security-summary.md) |
| Compromised admin key | New admin calls `set_admin` (single step, 720-ledger cooldown); if the key is the attacker's, use the multisig `propose_pause` | Security lead + Contracts lead | [multisig-admin-runbook.md §5](multisig-admin-runbook.md) |
| Lost or compromised multisig signer | `propose_rotate_signer` → threshold → 34 560-ledger timelock → `finalize_signer_rotation`. Approvals by the old key stop counting once it is removed. | Remaining signers | [multisig-admin-runbook.md §4–5](multisig-admin-runbook.md), [disaster-recovery-multisig-signers.md](disaster-recovery-multisig-signers.md) |
| Majority of signers compromised | The multisig cannot protect the contract; fall back to the admin path and incident response | Security lead | [multisig-admin-runbook.md](multisig-admin-runbook.md#emergency-majority-of-signers-compromised) |
| Bad upgrade | `upgrade` back to the last known-good hash after `rehearse_rollback`; upgrades are rate-limited (1 440) | Release lead + Contracts lead | [mainnet-rollback-runbook.md](mainnet-rollback-runbook.md) |
| Tripped oracle circuit | Confirm oracle health, then `reset_oracle_circuit` or register a replacement | Admin / governance | [oracle-integration.md](oracle-integration.md) |

**Owner actions before mainnet:**
- `.github/mainnet-admin-signers.json` still lists **no** signers.
- The signer holders in [multisig-admin-runbook.md §1](multisig-admin-runbook.md#1-production-signer-set) are examples.
- The security contact channel is not yet working ([SECURITY.md](../SECURITY.md#contact-status)).

## 5. Validation against the ABI / spec

- This matrix was checked against the `#[contractimpl]` source of each contract at the commit that adds it. Every row names a function that exists there.
- `docs/contract-spec.json` is **stale**. It lists 60 functions while source exports about 118, and it still contains `set_treasury_address`, `update_protocol_fee_bps`, `submit_invoice_auction`, `get_lp_portfolio_stats`, `get_invoice_nft_metadata`, `get_invoice_nft_owner` and `invoice_nft_exists`, none of which exist. Regenerate it with `make spec` (preferably from the built WASM via `stellar contract inspect`) before using it as the deployed-ABI reference. The release WASM build is currently blocked by F-12 in the custody matrix.
- Against a deployed contract: `stellar contract info interface --id <CONTRACT_ID> --network <net>` lists the exported functions. Every function in that output that is not a view must appear in §2.
