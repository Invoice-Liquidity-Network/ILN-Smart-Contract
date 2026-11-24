# Governance storage layout and migration behaviour

**Scope:** `contracts/iln_governance` (`StorageKey` in `src/lib.rs`) and the
migration tests at the end of `src/test.rs` (`test_migration_*`).

`iln_governance` has no in-contract migration code. A Soroban WASM upgrade
keeps storage and swaps the code, so a new build must read whatever an older
build left behind. This page defines what it does when an entry is present,
absent, or inconsistent. For the byte-level key table see
[`storage-layout.md`](storage-layout.md) §6.

## 1. Key classification

### Required – no default, fail closed when absent

| Key | Storage | Absent behaviour |
| --- | --- | --- |
| `IlnContract`, `GovToken`, `DistributionContract`, `ReputationBonusContract` | instance | `NotInitialized` from every function that needs the address |
| `Admin` | instance | `NotInitialized` from admin-gated functions |
| `MinQuorumBps` | instance | `QuorumDataMissing` when an `Active` proposal is settled; proposal is **not** mutated |
| `GovTokenTotalSupply` | instance | same as above (a missing or non-positive supply never means quorum 0) |
| `Proposal(id)` for `id <= ProposalCount` | persistent | `ProposalStorageCorrupt` |

### Optional – absent reads as a documented default

| Key | Default when absent |
| --- | --- |
| `ExecutionDelay` | `0` |
| `TimelockPolicyVersion` | `0` |
| `MaxScheduledEta` | `0` |
| `Paused` | `false` |
| `ExecutionNonce` | `0` |
| `MinProposalDeposit` | `0` (deposits disabled) |
| `QuadraticVotingEnabled` | `false` |
| `MaxDelegationDepth` | `10` |
| `ProposalTimelockPolicy(id)` | legacy proposal: queued under the current policy, or fail closed to `eta_ledger + delay` if already `Passed` |

### Consistency checks

| Condition | Result |
| --- | --- |
| `id == 0` or `id > ProposalCount` | `ProposalNotFound` |
| `id <= ProposalCount` but record missing | `ProposalStorageCorrupt` |
| record's `id` differs from its key | `ProposalStorageCorrupt` |
| `initialize` called again | `AlreadyInitialized`, no field changed |

## 2. What the tests pin

| Test | Case |
| --- | --- |
| `test_migration_layout_without_optional_keys_reads_defaults` | normal: older layout without newer keys, full proposal lifecycle still works |
| `test_migration_reinitialize_is_rejected_and_config_unchanged` | repeated / unauthorized: re-running `initialize` cannot replace config or admin |
| `test_migration_missing_proposal_record_fails_closed` | interrupted: issued id with no record |
| `test_migration_proposal_id_mismatch_fails_closed` | interrupted: record stored under another proposal's key |
| `test_migration_unissued_proposal_ids_are_not_found` | stale: ids that were never issued stay distinct from corruption |
| `test_migration_missing_quorum_config_fails_closed_without_mutation` | interrupted: quorum config missing at settlement |
| `test_migration_missing_iln_contract_key_fails_closed` | interrupted: governed-contract address missing |
| `test_migration_config_and_proposal_survive_ledger_advance` | normal: same storage read later |

Pre-existing coverage of proposal-level legacy data:
`test_legacy_proposal_without_snapshot_is_queued_under_current_policy`,
`test_legacy_queued_proposal_fails_closed_to_eta_plus_delay`.

## 3. Residual risk (observed, not changed here)

- **`initialize` is guarded by the presence of `IlnContract`.** If that single
  entry were lost, `initialize` would succeed again and let the caller choose a
  new admin. A WASM upgrade does not delete instance keys, so this needs a
  storage-corrupting bug to reach; it is not reachable through the public API.
  A dedicated `Initialized` flag would remove the dependency.
- **`ProposalCount` defaults to `0` when absent.** The next `create_proposal`
  would reuse id `1` and overwrite an existing record. Same precondition as
  above (key loss), same mitigation (an upgrade that touches storage must
  preserve instance keys).
- **No schema version key.** New optional keys rely on "absent means default".
  A change that needs a different meaning for an *existing* key requires an
  explicit, reviewed migration and a version marker.
- Tests simulate older layouts by removing or overwriting entries. They do not
  replay a real prior-WASM-to-new-WASM upgrade.

## 4. Rules for future storage changes

1. Add new instance keys as optional with a safe default (fail closed for
   anything that gates execution, voting power or quorum).
2. Never change the meaning, type or key shape of an existing variant; add a
   new variant instead. Variant order in the `StorageKey` enum does not need to
   be preserved, but names and payload shapes do.
3. Add a `test_migration_*` case for every new key (absent value + one failure).
4. Update this page and `storage-layout.md` in the same PR.
