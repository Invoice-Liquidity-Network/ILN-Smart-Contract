# Multi-sig Admin Runbook

**Status:** Production procedure — follow this to stand up the `invoice_liquidity` multi-sig admin before mainnet launch.

This runbook defines the **production signer set**, the **key generation ceremony**, **key custody**, **backup/recovery**, and **signer rotation** for the threshold multi-signature admin implemented in `contracts/invoice_liquidity/src/multisig.rs` and exposed on the `invoice_liquidity` contract (see [ADR-008](adr/adr-008-multisig-admin.md)).

## 1. Production signer set

The contract requires a threshold scheme of **M-of-N** signers. The minimum
production configuration is **3 independent signer keys with a threshold of 2
(2-of-3)**:

| Parameter | Production value | Rationale |
|-----------|------------------|-----------|
| `signers` | 3 independent keys, held by 3 different individuals/organizations | No single entity controls the admin |
| `threshold` | 2 | One compromised or lost key can never act alone, but a single signer being unavailable does not block emergency operations |
| `MULTISIG_WINDOW_LEDGERS` | 17,280 (~24h at 5s/ledger) | Proposals expire after ~24h if they do not reach threshold |

### Signer roles (example)

| Key | Holder | Primary duty |
|-----|--------|--------------|
| Signer A | Protocol lead | Proposes routine admin actions (pause/unpause) |
| Signer B | Security lead | Independent approval; holds emergency authority |
| Signer C | Infrastructure/ops lead | Independent approval; backup for A/B unavailability |

Signers must be **independent**: different organizations/individuals, no shared
custody, no shared seed phrases, and no key derived from another signer's key.

## 2. Key generation ceremony (offline / air-gapped)

Each signer key must be generated **offline** on hardware that has never been
connected to a network and never will be. This prevents seed-phrase or private
key exposure during generation.

### Requirements

- A clean, air-gapped machine (a dedicated laptop or single-board computer
  that has never been online), or a hardware wallet used in its offline setup
  mode.
- The machine must be booted from a trusted, verified OS image.
- Physical access control: only the signer and one witness (the "ceremony
  observer") present during generation.
- A camera-free room, or cameras covered, while the seed is displayed.

### Procedure

1. **Boot** the air-gapped machine from the verified OS image.
2. **Generate** the key with a tool that outputs a Stellar keypair, e.g. the
   Stellar CLI:
   ```bash
   stellar keys generate --output-file /media/encrypted-usb/signer-a.json
   ```
   or, with `stellar-sdk`/`soroban-cli` equivalents, ensure the output is a
   Stellar `G...` public key and `S...` secret key pair.
3. **Verify** the public key by deriving it back from the secret:
   ```bash
   stellar keys address --secret-key "$(cat /media/encrypted-usb/signer-a.json)"
   ```
   The ceremony observer records the derived public key independently.
4. **Record the public key** (only the public key) on the ceremony log along
   with the date, machine identity, and observer signature. Public keys are
   safe to share; secret keys never leave the encrypted media.
5. **Power down**, then store the encrypted media per the custody rules in
   §3.
6. Repeat for each signer key (A, B, C).

## 3. Key custody and hardware wallet requirements

- **Production signers must use hardware wallets** (Ledger, Trezor, or
  equivalent with a certified secure element) for signing. The private key is
  generated on and protected by the device and never exported.
- The hardware wallet must be:
  - Purchased from the manufacturer or an authorized reseller (not second-hand),
  - Updated to a verified firmware before first use,
  - Protected by a PIN, and
  - Paired to its companion app only on a trusted machine.
- Each signer keeps their recovery seed phrase **offline** (engraved metal
  plate or paper stored in a fireproof safe), never in a password manager, in
  email, or in a cloud drive.
- **No single person** may hold more than one signer's seed phrase, and no
  two signers may store their phrases in the same physical location.

## 4. Backup / recovery procedure for a lost signer key

Because the threshold is 2-of-3, losing one signer key does **not** block
admin operations. Recovery happens at two levels:

### 4.1 Restoring a lost signer's *device* (same key)

If a signer loses their hardware wallet but still has their seed phrase:

1. Restore the seed phrase on a **new** hardware wallet of the same brand
   (follow the manufacturer's recovery procedure).
2. Verify the restored device derives the same public key as the original
   (compare against the ceremony log).
3. Test a signature with a small test transaction before relying on the
   restored device.

### 4.2 Replacing a signer whose key is permanently lost or compromised

If the seed phrase is also lost (key cannot be recovered) — or the key is
compromised — the signer must be **rotated out** of the set. See §5. Rotation
does **not** require a contract upgrade.

## 5. Rotating a compromised or lost signer (no contract upgrade)

The signer set and threshold are stored in contract storage, so rotation is a
data change, not a code change. Rotation uses the same proposal mechanism —
**the remaining signers propose the new configuration, reach threshold, and
execute**.

For a 2-of-3 setup where Signer C must be replaced by Signer D:

1. Signers A and B (threshold = 2) agree on the replacement.
2. Signer A proposes the updated signer set via the multisig proposal flow.
   The `AdminAction::UpdateMultisig` variant carries
   `(new_signers, new_threshold)` — e.g. `[A, B, D]` with threshold `2`.
   > Note: v1 of the contract implements execution of `Pause` / `Unpause`.
   > `UpdateMultisig` is defined in the `AdminAction` enum (reserved for
   > execution in a follow-up release), so until execution lands, rotate by
   > re-running the initialization flow with the new signer set.
3. Signer B signs the proposal.
4. Once the threshold is reached, the proposal executes and the stored
   `MultisigAdmin` reflects the new set.
5. **Immediately after rotation:** revoke the compromised key from all
   services that hold it, notify the remaining signers, and record the
   rotation in the incident log. If the compromised key is a *current* signer
   and the threshold was 2-of-3, the compromised key alone still cannot act —
   this is exactly what the threshold protects against.

### Emergency: majority of signers compromised

If more than the threshold of signers is compromised (e.g. 2 of 2-of-3), the
multisig alone cannot protect the contract. Fall back to the incident
response procedure in [Security](security.md) and consider a governance or
protocol-level intervention.

## 6. Standing up the production configuration

Once the three signer keys exist and are verified:

1. Deploy the `invoice_liquidity` contract (see [Developer Quickstart](developer-quickstart.md)).
2. Call `initialize(...)` with the deployer admin.
3. Call `initialize_multisig_admin(signers, threshold)` with:
   - `signers = [SignerA, SignerB, SignerC]` (3 public keys),
   - `threshold = 2`.
   The call is rejected with `InvalidMultisigConfig` unless
   `0 < threshold <= signers.len()`.
4. Verify the configuration with `get_multisig_admin()`.
5. Update [mainnet-launch-checklist.md](mainnet-launch-checklist.md) status to
   `Complete` for "Multi-sig admin configured".

## 7. Verifying the production threshold in tests

The exact production flow — 3 independent signers, threshold 2-of-3, propose →
sign → execute, and the guarantee that a single compromised key is never
sufficient — is covered by the integration test
`test_production_threshold_multisig_flow` in
`contracts/invoice_liquidity/src/tests_multisig_admin.rs`.

Run it with:

```bash
cargo test -p invoice_liquidity --lib tests_multisig_admin
```

The test asserts, in order:

1. A pause proposal created by Signer A returns a valid proposal ID.
2. Executing with **only** Signer A's signature fails with
   `ThresholdNotReached` and the contract stays unpaused.
3. Adding Signer B's signature (2-of-3 reached) lets the proposal execute and
   the contract becomes paused.
4. Recovery follows the same threshold: two signatures unpause the contract.
5. A non-signer can never propose.

## 8. Signing ceremony checklist (per admin action)

| Step | Actor | Action |
|------|-------|--------|
| 1 | Any signer | Propose the action (`propose_pause` / `propose_unpause`) |
| 2 | Second signer | Independently verify the action and sign the proposal |
| 3 | Any signer | Execute once threshold is met (proposal expires after ~24h otherwise) |
| 4 | All signers | Verify the on-chain result and record it in the ops log |
