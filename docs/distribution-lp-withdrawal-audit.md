# Distribution LP Withdrawal Authorization Audit

Scope: `contracts/iln_distribution/src/lib.rs`; tests in
`tests_lp_withdrawal_auth.rs` (plus existing `tests_custody.rs` and `test::*`).

## Terminology

* **Withdrawal** = `claim_tokens(claimer)`.
* **Pending payout** = `total_earned(claimer) - Claimed(claimer)`.
* **Treasury** = the governance-token SAC whose admin is the distribution
  contract. It mints on claim and holds no pre-funded balance.

## Authorization rules (verified)

| Operation | Who | Mechanism |
| --- | --- | --- |
| `claim_tokens(claimer)` | `claimer` | `claimer.require_auth()`; mints to `claimer` only |
| `accrue_lp`, `accrue_settlement` | bound ILN contract | `IlnContract.require_auth()` |
| `set_*_reward_rate` | bound ILN contract | same address |
| `initialize` | once | `AlreadyInitialized`; SAC admin must be this contract |

## Verified behavior

* W1: no other address can claim for, or read-modify-write, a claimer's keys.
* W2: `Claimed` is a high-water mark. A rate decrease can push earned below
  claimed; the claim then pays 0 (no revert, no claw-back). A later raise pays
  only `earned - claimed`.
* W3: a negative rate gives a non-positive accrual and a 0 claim.
* W4: pending payouts and balances are per address.
* W5: `floor(volume / 100 USDC) * rate`; splitting volume cannot round up.
* W6: a failed re-initialize does not rebind the ILN address or token.
* Rejected accruals (<= 0, > `MAX_LP_ACCRUAL_PER_CALL`) are ignored and leave
  pending payouts unchanged.

## Failure behavior

| Case | Result |
| --- | --- |
| Repeated claim | returns 0, mints nothing |
| Unauthorized claim / accrual / rate change | auth failure; no state change |
| Stale rate | accrual is recomputed from current rates at claim time |
| Interrupted (mint fails) | invocation reverts; `Claimed` is written after the mint, so no unpaid claim is recorded |

## Residual risk (not changed)

* Reward rates are unbounded `i128` and retroactive over all accrued volume.
  Raising a rate lets everyone claim more; lowering one blocks new claims but
  cannot recover tokens already minted. The only guard is that the ILN
  contract is the sole caller, so rate governance is as strong as ILN's own
  admin controls.
* `Claimed` and accrual entries live in persistent storage. If one were
  archived, access requires restoration rather than reading as zero, so a
  claim cannot be replayed through expiry. Operators should keep TTLs extended.
