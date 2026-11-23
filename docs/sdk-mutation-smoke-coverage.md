# SDK mutation smoke coverage (testnet)

A *mutation* is any function in `sdk/src/methods` that signs and submits a transaction.
Unit tests under `src/methods/*.test.ts` mock the RPC and prove encoding, not chain behaviour.
The smoke suite runs against the live testnet deployment and asserts **confirmed on-chain state**
by reading it back through the contract's own query methods. A returned `txHash` never counts as a pass.

- Map: [`sdk/tests/integration/smoke/mutationRegistry.ts`](../sdk/tests/integration/smoke/mutationRegistry.ts)
- Offline guard: `mutationRegistry.test.ts` (same folder, runs in the normal unit run)
- Smoke tests: `tests/integration/invoiceLifecycle.integration.test.ts`, `smoke/invoiceMutations.integration.test.ts`, `smoke/insuranceMutations.integration.test.ts`

## Running

| Suite | Environment | Without it |
| --- | --- | --- |
| Invoice lifecycle and invoice mutations | `TEST_SUBMITTER_SECRET`, `TEST_LP_SECRET` (Friendbot-funded; the LP must hold testnet USDC) | skipped |
| Insurance enrollment | the two above for the helpers, plus `INSURANCE_POOL_ID` | skipped |

Optional: `TEST_RPC_URL`. Run with `cd sdk && pnpm test:integration`.

## Coverage (9 of 51 mutations have a smoke test)

| Mutation | Smoke test | Chain state asserted | Failure cases asserted |
| --- | --- | --- | --- |
| `submitInvoice` | lifecycle | status `Pending` | |
| `fundInvoice` | lifecycle | status `Funded`, `funder` = LP | |
| `markPaid` | lifecycle | status `Paid` | |
| `cancelInvoice` | `invoiceMutations` | status `Cancelled` | repeat cancel; non-submitter (status stays `Pending`) |
| `transferInvoice` | `invoiceMutations` | `freelancer` = new owner | non-owner; previous owner (stale) |
| `transferLPPosition` | `invoiceMutations` | `funder` = new LP | non-LP; previous LP (stale) |
| `submitInvoicesBatch` | `invoiceMutations` | each id: status, freelancer, payer, amount, rate | batch of 11 refused |
| `disputeInvoice` | `invoiceMutations` | status `Disputed` | non-payer; repeat dispute |
| `enrollInsurancePool` | `insuranceMutations` | `isEnrolled` false -> true | |

The other 42 mutations are `deferred` in the registry with a reason:

- **needs-admin-key** (10): admin-only entry points. The smoke environment has no admin secret, and several of them
  change fees, limits or the allow-list of the shared deployment.
- **needs-governance** (14): need a governance contract, a passed proposal or an execution delay.
- **needs-second-contract** (10): distribution, fund queue, reputation bonus, second token. These contract ids are empty
  in the testnet registry.
- **needs-default-state** (4): `appealInvoice`, `resolveAppeal`, `claimInsurance` and `handleDefault` need an invoice that has defaulted.
- **destructive** (4): `pause`, `unpause`, `setAdmin` and `upgrade` would break the shared deployment other suites use.

The offline guard fails when a new exported function in `src/methods` is in neither `MUTATIONS` nor `READ_ONLY`,
when a registry entry is stale, when a `smoke` entry names a test that does not exist, never calls the mutation or never reads
state back, and when a deferral has no reason.

## Observable behaviour defined by the suite

- **Normal:** the mutation succeeds and the read-back state matches. Polling (2 s interval, 60 s timeout) absorbs ledger latency.
  On timeout the test reports the last observed state.
- **Repeated:** a second identical call is refused and state is unchanged (`cancelInvoice`, `disputeInvoice`).
- **Unauthorized:** the wrong signer is refused and state is unchanged (`cancelInvoice`, `transferInvoice`, `transferLPPosition`, `disputeInvoice`).
- **Stale:** after ownership moves, the previous owner or LP is refused (`transferInvoice`, `transferLPPosition`).
- **Interrupted:** not covered. See the residual risk below.

## Findings

Verified by reading the code:

1. **`invoiceLifecycle` never exercised `cancelInvoice`.** It only calls it from teardown, and only when the invoice is still
   `Pending`, which never happens after a successful run. It is now covered directly.
2. **Eight mutations return before the transaction is confirmed:** `transferInvoice`, `disputeInvoice`, `resolveDispute`,
   `appealInvoice`, `resolveAppeal`, `pause`, `unpause` and `convertInvoiceToken`.
   They stop after `sendTransaction` and never call `getTransaction`. `errorResult` is only set when the node rejects the submission
   immediately. A transaction accepted as PENDING that later fails on-chain is reported as success with a `txHash`.
   The others (`cancelInvoice`, `submitInvoice`, `markPaid`, `transferLPPosition`, `enrollInsurancePool`, ...) poll to a final status.
   This is why the smoke tests poll the read API instead of trusting the return value.

## Residual risk (not changed here)

- The confirmation gap in finding 2 is a behaviour change to the SDK, so it belongs in a separate PR.
  The smoke tests for `transferInvoice` and `disputeInvoice` would catch a regression once it is fixed.
- The suite was written without access to a live testnet run in this change. It is skipped without credentials.
  Treat the first CI run as the verification of the on-chain assertions, in particular the expected refusals.
- There is no smoke test for an interrupted submission (a transaction accepted but never included).
- Smoke runs leave `Disputed` and `Funded` invoices on the shared deployment. Only `Pending` invoices are cleaned up.
