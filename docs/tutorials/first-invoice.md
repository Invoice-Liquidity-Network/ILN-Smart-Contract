# First Invoice: Hands-On Tutorial

This tutorial walks you through the full invoice lifecycle on the ILN testnet:
submit an invoice as a freelancer, fund it as a liquidity provider, settle it
as the payer, and query the final state. Every step is shown in both the
Stellar CLI and TypeScript SDK.

**Time to complete:** ~20 minutes  
**Network:** Stellar testnet  
**Contract:** `CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC`

---

## Prerequisites

- Stellar CLI installed (`cargo install --locked stellar-cli`)
- Node.js ≥ 18 and `npm` (for the SDK path)
- `curl` for Friendbot

If you need to install the Stellar CLI or Rust toolchain first, see the
[Developer Quickstart](../developer-quickstart.md).

---

## 1. Set Up Accounts

You need three testnet accounts: a **freelancer**, a **payer**, and a
**liquidity provider (LP)**. Each must hold XLM (for fees) and testnet USDC
(for the invoice token).

### 1a. Generate keys

```bash
stellar keys generate --global freelancer
stellar keys generate --global payer
stellar keys generate --global lp

# Print the public keys — save these for later
stellar keys address freelancer
stellar keys address payer
stellar keys address lp
```

### 1b. Fund with XLM via Friendbot

```bash
stellar network fund freelancer --network testnet
stellar network fund payer      --network testnet
stellar network fund lp         --network testnet
```

Each account receives 10 000 XLM on testnet.

### 1c. Add a USDC trustline and mint tokens

The testnet USDC SAC address is:
`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

Use the [Stellar Laboratory](https://laboratory.stellar.org/#txbuilder?network=test)
to add a trustline for each account, then mint tokens from the USDC SAC admin.
Alternatively, use the SDK snippet below:

```ts
import { Asset, Keypair, Networks, Operation, Server, TransactionBuilder } from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const server  = new Server(HORIZON);

async function addUsdcTrustline(kp: Keypair) {
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
      })
    )
    .setTimeout(30)
    .build();
  tx.sign(kp);
  await server.submitTransaction(tx);
}
```

> **Tip:** For a quick smoke test you can use XLM instead of USDC — just pass
> the XLM SAC address as the `token` argument and adjust amounts to 7-decimal
> stroops (`10_000_000` = 1 XLM).

---

## 2. Configure the Stellar CLI Network

```bash
stellar network add \
  --global testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

Set a shell variable for the contract ID to keep commands short:

```bash
export CONTRACT=CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC
export USDC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

---

## 3. Submit an Invoice

The freelancer registers a 500 USDC invoice due in 48 hours with a 3 % discount
for the LP.

**Amount:** 500 USDC = `500000000` stroops (6 decimals)  
**Due date:** Unix timestamp 48 hours from now  
**Discount rate:** `300` basis points = 3 %

### CLI

```bash
# Compute a due date 48 hours from now
DUE_DATE=$(( $(date +%s) + 172800 ))

stellar contract invoke \
  --network testnet \
  --source freelancer \
  --id $CONTRACT \
  -- submit_invoice \
  --freelancer $(stellar keys address freelancer) \
  --payer     $(stellar keys address payer) \
  --amount    500000000 \
  --due_date  $DUE_DATE \
  --discount_rate 300 \
  --token     $USDC
```

The command prints the new **invoice ID** (a `u64`). Save it:

```bash
export INVOICE_ID=<printed_id>
```

### SDK

```ts
import {
  Contract, Keypair, Networks, SorobanRpc,
  TransactionBuilder, nativeToScVal, scValToNative, xdr, Address,
} from "@stellar/stellar-sdk";

const RPC_URL        = "https://soroban-testnet.stellar.org";
const CONTRACT_ID    = "CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC";
const USDC_TOKEN     = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NETWORK_PHRASE = Networks.TESTNET;

const server = new SorobanRpc.Server(RPC_URL);

// Reusable helper — sign, simulate, submit, poll
async function invoke(caller: Keypair, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const account  = await server.getAccount(caller.publicKey());
  const contract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`Simulation: ${sim.error}`);

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(caller);

  const response = await server.sendTransaction(prepared);
  if (response.status === "ERROR") throw new Error(JSON.stringify(response.errorResult));

  let result = await server.getTransaction(response.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    result = await server.getTransaction(response.hash);
  }
  if (result.status !== "SUCCESS") throw new Error(`TX failed: ${result.status}`);
  return result.returnValue ?? xdr.ScVal.scvVoid();
}

// ── Step 3: Submit invoice ───────────────────────────────────────────────────
const freelancer = Keypair.fromSecret("S_FREELANCER_SECRET");
const dueDateUnix = Math.floor(Date.now() / 1000) + 2 * 86400; // 48 h from now

const invoiceIdVal = await invoke(freelancer, "submit_invoice", [
  new Address(freelancer.publicKey()).toScVal(),          // freelancer
  new Address("G_PAYER_PUBLIC_KEY").toScVal(),            // payer
  nativeToScVal(500_000_000n, { type: "i128" }),          // amount (500 USDC)
  nativeToScVal(dueDateUnix,  { type: "u64" }),           // due_date
  nativeToScVal(300,          { type: "u32" }),           // discount_rate (3 %)
  new Address(USDC_TOKEN).toScVal(),                      // token
]);

const invoiceId = scValToNative(invoiceIdVal) as bigint;
console.log("Invoice ID:", invoiceId);
```

**Constraints to keep in mind:**
- `amount` must be ≥ 1 000 000 (1 USDC minimum).
- `due_date` must be at least 24 hours and at most 365 days in the future.
- `discount_rate` must be between 1 and 5 000 bps (50 %).
- `freelancer` and `payer` must be different addresses.

---

## 4. Fund the Invoice (LP)

The LP advances capital. The contract immediately pays the freelancer
`amount × (1 − discount_rate / 10 000)` = 485 USDC, and holds the LP's
principal until the payer settles.

### CLI

```bash
stellar contract invoke \
  --network testnet \
  --source lp \
  --id $CONTRACT \
  -- fund_invoice \
  --funder   $(stellar keys address lp) \
  --invoice_id $INVOICE_ID \
  --fund_amount 500000000 \
  --require_oracle_verification false
```

### SDK

```ts
// ── Step 4: Fund invoice ─────────────────────────────────────────────────────
const lp = Keypair.fromSecret("S_LP_SECRET");

await invoke(lp, "fund_invoice", [
  new Address(lp.publicKey()).toScVal(),              // funder
  nativeToScVal(invoiceId, { type: "u64" }),          // invoice_id
  nativeToScVal(500_000_000n, { type: "i128" }),      // fund_amount
  nativeToScVal(false, { type: "bool" }),             // require_oracle_verification
]);

console.log("Invoice funded — freelancer received 485 USDC");
```

> **Partial funding:** You can call `fund_invoice` multiple times with smaller
> amounts. The invoice status will be `PartiallyFunded` until
> `amount_funded == amount`.

---

## 5. Mark the Invoice Paid (Payer)

The payer settles the full invoice amount. The contract distributes the funds
to the LP (principal + discount yield) and increments the payer's reputation
score.

### CLI

```bash
stellar contract invoke \
  --network testnet \
  --source payer \
  --id $CONTRACT \
  -- mark_paid \
  --invoice_id $INVOICE_ID \
  --amount 500000000
```

### SDK

```ts
// ── Step 5: Mark paid ────────────────────────────────────────────────────────
const payer = Keypair.fromSecret("S_PAYER_SECRET");

await invoke(payer, "mark_paid", [
  nativeToScVal(invoiceId, { type: "u64" }),      // invoice_id
  nativeToScVal(500_000_000n, { type: "i128" }),  // amount
]);

console.log("Invoice settled — LP received 500 USDC (485 principal + 15 yield)");
```

> **Partial payment:** Pass a smaller `amount` to make a partial payment. The
> invoice stays `Funded` until `amount_paid == amount`.

---

## 6. Query the Invoice State

Read the final invoice struct. This is a simulation (no signing or fees).

### CLI

```bash
stellar contract invoke \
  --network testnet \
  --source freelancer \
  --id $CONTRACT \
  -- get_invoice \
  --invoice_id $INVOICE_ID
```

Expected output (abbreviated):

```json
{
  "id": 1,
  "status": { "tag": "Paid" },
  "freelancer": "GFREELANCER...",
  "payer": "GPAYER...",
  "amount": 500000000,
  "amount_funded": 500000000,
  "amount_paid": 500000000,
  "discount_rate": 300
}
```

### SDK

```ts
// ── Step 6: Query invoice ────────────────────────────────────────────────────
async function getInvoice(id: bigint) {
  const account  = await server.getAccount(Keypair.random().publicKey());
  const contract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PHRASE })
    .addOperation(contract.call("get_invoice", nativeToScVal(id, { type: "u64" })))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result!.retval) as Record<string, unknown>;
}

const invoice = await getInvoice(invoiceId);
console.log(invoice);
// { id: 1n, status: { tag: 'Paid' }, amount: 500000000n, amount_paid: 500000000n, ... }
```

---

## 7. Full End-to-End Script

Copy this file to `scripts/smoke-test.ts`, fill in your secrets, and run it
with `npx ts-node scripts/smoke-test.ts`.

```ts
import {
  Contract, Keypair, Networks, SorobanRpc,
  TransactionBuilder, nativeToScVal, scValToNative, xdr, Address,
} from "@stellar/stellar-sdk";

const RPC_URL        = "https://soroban-testnet.stellar.org";
const CONTRACT_ID    = "CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC";
const USDC_TOKEN     = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NETWORK_PHRASE = Networks.TESTNET;
const server         = new SorobanRpc.Server(RPC_URL);

async function invoke(caller: Keypair, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const account  = await server.getAccount(caller.publicKey());
  const contract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`Simulation: ${sim.error}`);
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(caller);
  const response = await server.sendTransaction(prepared);
  if (response.status === "ERROR") throw new Error(JSON.stringify(response.errorResult));
  let result = await server.getTransaction(response.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    result = await server.getTransaction(response.hash);
  }
  if (result.status !== "SUCCESS") throw new Error(`TX failed: ${result.status}`);
  return result.returnValue ?? xdr.ScVal.scvVoid();
}

async function main() {
  // Replace with real testnet secrets
  const freelancer = Keypair.fromSecret("S_FREELANCER_SECRET");
  const lp         = Keypair.fromSecret("S_LP_SECRET");
  const payer      = Keypair.fromSecret("S_PAYER_SECRET");

  const due = Math.floor(Date.now() / 1000) + 2 * 86400;

  // 1. Submit
  const idVal    = await invoke(freelancer, "submit_invoice", [
    new Address(freelancer.publicKey()).toScVal(),
    new Address(payer.publicKey()).toScVal(),
    nativeToScVal(500_000_000n, { type: "i128" }),
    nativeToScVal(due,          { type: "u64" }),
    nativeToScVal(300,          { type: "u32" }),
    new Address(USDC_TOKEN).toScVal(),
  ]);
  const invoiceId = scValToNative(idVal) as bigint;
  console.log("Submitted invoice:", invoiceId);

  // 2. Fund
  await invoke(lp, "fund_invoice", [
    new Address(lp.publicKey()).toScVal(),
    nativeToScVal(invoiceId,    { type: "u64" }),
    nativeToScVal(500_000_000n, { type: "i128" }),
    nativeToScVal(false,        { type: "bool" }),
  ]);
  console.log("Funded");

  // 3. Pay
  await invoke(payer, "mark_paid", [
    nativeToScVal(invoiceId,    { type: "u64" }),
    nativeToScVal(500_000_000n, { type: "i128" }),
  ]);
  console.log("Paid");

  // 4. Verify
  const account  = await server.getAccount(Keypair.random().publicKey());
  const contract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PHRASE })
    .addOperation(contract.call("get_invoice", nativeToScVal(invoiceId, { type: "u64" })))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const inv = scValToNative(sim.result!.retval) as Record<string, unknown>;

  const status = (inv.status as { tag: string }).tag;
  console.assert(status === "Paid", `Expected Paid, got ${status}`);
  console.log("✓ Smoke test passed — invoice status:", status);
}

main().catch(console.error);
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `ContractError(2)` InvoiceNotFound | Wrong invoice ID | Check `$INVOICE_ID` is set correctly |
| `ContractError(7)` Unauthorized | Caller not authorised (wrong `--source`) | Use the correct key for each step |
| `ContractError(10)` InvalidDueDate | `due_date` too soon or too far | Must be 24 h – 365 days in the future |
| `ContractError(11)` OverfundingRejected | `fund_amount` exceeds remaining | Pass exactly the remaining unfunded amount |
| `ContractError(12)` OverpaymentRejected | `amount` exceeds remaining balance | Pass exactly the remaining unpaid amount |
| `ContractError(16)` DueDateTooSoon | Due date < 24 h away | Add at least 86 400 seconds to `due_date` |
| `Simulation failed` | Account not funded or no trustline | Run Friendbot and add USDC trustline |

---

## Next Steps

- [SDK Integration Guide](../sdk-integration.md) — full API reference with all functions
- [Contract ABI](../contract-abi.md) — complete function signatures and error codes
- [Events](../events.md) — subscribe to on-chain events emitted by each step
- [Architecture](../Architecture.md) — understand the money flow and security model
