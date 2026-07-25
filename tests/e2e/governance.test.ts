import { Account, Keypair, SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import {
  createProposal,
  castVote,
  executeProposal,
  getProposal,
} from "../../sdk/src/methods/governance.js";
import { submitInvoice } from "../../sdk/src/methods/submitInvoice.js";
import {
  ProposalAction,
  ProposalStatus,
} from "../../sdk/src/types/governance.js";
import { advanceLedger } from "./setup/helpers.js";

/**
 * E2E — Governance proposal lifecycle.
 *
 * Proves the governance loop end to end:
 *   create proposal → vote to quorum → wait out the voting period
 *   → advance past the ledger timelock → execute → verify the parameter
 *   change is enforced by the main invoice contract.
 *
 * The "parameter change" under test is the **minimum invoice amount**
 * (`MIN_INVOICE_AMOUNT`): after the proposal executes we submit a
 * below-threshold invoice and confirm the main contract rejects it.
 *
 * Like {@link file://./lifecycle.test.ts}, this test touches a live chain and a
 * fully-wired governance + invoice deployment, so it is **skipped by default**
 * and only runs when the operator supplies funded secret keys and the two
 * contract IDs. That keeps the default `npm run test:e2e` run hermetic.
 *
 * Required environment to run:
 *   TEST_GOV_PROPOSER_SECRET  funded account that creates the proposal (holds gov tokens)
 *   TEST_GOV_VOTER_SECRET     funded account with enough voting weight to pass quorum
 *   ILN_GOVERNANCE_ID         deployed governance contract id
 *   INVOICE_LIQUIDITY_ID      deployed invoice contract id governed by it
 * Optional:
 *   GOV_NETWORK_PASSPHRASE    defaults to the standalone-network passphrase
 *   GOV_NEW_MIN_INVOICE       new MIN_INVOICE_AMOUNT to propose (stroops, default 5_000_000)
 *   GOV_TOTAL_SUPPLY          gov-token total supply used for quorum math (default 1_000_000)
 *   GOV_TIMELOCK_LEDGERS      ledgers to advance to clear the execution timelock (default 5)
 */

const RPC_URL = process.env.STELLAR_RPC_URL || "http://localhost:8000";
const NETWORK_PASSPHRASE =
  process.env.GOV_NETWORK_PASSPHRASE || "Standalone Network ; February 2017";

const GOVERNANCE_ID = process.env.ILN_GOVERNANCE_ID;
const INVOICE_ID = process.env.INVOICE_LIQUIDITY_ID;
const PROPOSER_SECRET = process.env.TEST_GOV_PROPOSER_SECRET;
const VOTER_SECRET = process.env.TEST_GOV_VOTER_SECRET;

// The contract's `MIN_INVOICE_AMOUNT`-style threshold we want governance to set.
const NEW_MIN_INVOICE_AMOUNT = BigInt(
  process.env.GOV_NEW_MIN_INVOICE || "5000000",
);
const GOV_TOTAL_SUPPLY = BigInt(process.env.GOV_TOTAL_SUPPLY || "1000000");
const TIMELOCK_LEDGERS = Number(process.env.GOV_TIMELOCK_LEDGERS || "5");

/**
 * NOTE ON THE PROPOSED ACTION
 * ---------------------------
 * The proposal carries the new minimum amount in its generic `proposedValue`
 * (i128) field. Which on-chain parameter that value is applied to is decided by
 * the `action`. The action used here is read from `GOV_PROPOSAL_ACTION` so this
 * test tracks whatever discriminant the deployed governance contract maps to the
 * minimum-invoice-amount setter, and falls back to a sensible default.
 */
const PROPOSAL_ACTION: ProposalAction = Number(
  process.env.GOV_PROPOSAL_ACTION ?? ProposalAction.UpdateMinReputation,
) as ProposalAction;

// 32-byte hex hash of the (off-chain) proposal description.
const DESCRIPTION_HASH =
  "a".repeat(64); // placeholder keccak/sha256 of the proposal text

const shouldRun = Boolean(
  GOVERNANCE_ID && INVOICE_ID && PROPOSER_SECRET && VOTER_SECRET,
);

(shouldRun ? describe : describe.skip)(
  "E2E - Governance proposal lifecycle",
  () => {
    const server = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
    const proposer = Keypair.fromSecret(PROPOSER_SECRET as string);
    const voter = Keypair.fromSecret(VOTER_SECRET as string);

    /** Load a fresh Account (with current sequence) for `kp`. */
    async function loadAccount(kp: Keypair): Promise<Account> {
      const raw = await server.getAccount(kp.publicKey());
      return new Account(kp.publicKey(), raw.sequenceNumber());
    }

    /** Sign callback for governance writes (the SDK assembles the tx for us). */
    function signWith(kp: Keypair) {
      return (tx: Transaction) => {
        tx.sign(kp);
        return tx;
      };
    }

    it("changes MIN_INVOICE_AMOUNT via a full proposal lifecycle", async () => {
      // 1. Create the proposal: set MIN_INVOICE_AMOUNT to the new value.
      const proposerAccount = await loadAccount(proposer);
      const { proposalId } = await createProposal(
        server,
        GOVERNANCE_ID as string,
        PROPOSAL_ACTION,
        NEW_MIN_INVOICE_AMOUNT,
        DESCRIPTION_HASH,
        proposerAccount,
        signWith(proposer),
        NETWORK_PASSPHRASE,
      );
      expect(proposalId).toBeGreaterThan(0n);

      let proposal = await getProposal(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        proposerAccount,
        NETWORK_PASSPHRASE,
      );
      expect(proposal.status).toBe(ProposalStatus.Active);
      expect(proposal.proposedValue).toBe(NEW_MIN_INVOICE_AMOUNT);

      // 2. Cast votes to reach quorum. Proposer and voter both vote "for".
      await castVote(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        true,
        await loadAccount(proposer),
        signWith(proposer),
        NETWORK_PASSPHRASE,
      );
      await castVote(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        true,
        await loadAccount(voter),
        signWith(voter),
        NETWORK_PASSPHRASE,
      );

      proposal = await getProposal(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        proposerAccount,
        NETWORK_PASSPHRASE,
      );
      expect(proposal.votesFor).toBeGreaterThan(0n);
      expect(proposal.votesFor).toBeGreaterThan(proposal.votesAgainst);

      // 3. Wait for the voting period to close. The contract rejects execution
      //    while `now < voting_end`, so we busy-wait (advancing ledgers keeps the
      //    clock moving) until the window has elapsed.
      const votingEndsAt = proposal.votingEndsAt;
      while (Math.floor(Date.now() / 1000) < votingEndsAt) {
        await advanceLedger(1, { rpcUrl: RPC_URL });
      }

      // 4. First execute() call tallies the vote, marks the proposal Passed and
      //    arms the ledger-sequence timelock (`eta_ledger`).
      await executeProposal(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        await loadAccount(proposer),
        signWith(proposer),
        NETWORK_PASSPHRASE,
      );

      proposal = await getProposal(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        proposerAccount,
        NETWORK_PASSPHRASE,
      );
      expect([ProposalStatus.Passed, ProposalStatus.Executed]).toContain(
        proposal.status,
      );

      // 5. Advance past the timelock, then execute again to apply the change.
      await advanceLedger(TIMELOCK_LEDGERS, { rpcUrl: RPC_URL });
      await executeProposal(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        await loadAccount(proposer),
        signWith(proposer),
        NETWORK_PASSPHRASE,
      );

      proposal = await getProposal(
        server,
        GOVERNANCE_ID as string,
        proposalId,
        proposerAccount,
        NETWORK_PASSPHRASE,
      );
      expect(proposal.status).toBe(ProposalStatus.Executed);
    }, 600_000);

    it("rejects a below-threshold invoice after the parameter change", async () => {
      // The proposal above raised MIN_INVOICE_AMOUNT. Submitting an invoice for
      // less than the new minimum must now be rejected by the main contract.
      const proposerAccount = await loadAccount(proposer);
      const belowThreshold = NEW_MIN_INVOICE_AMOUNT - 1n;
      const dueDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      const token = process.env.GOV_TEST_TOKEN || (INVOICE_ID as string);

      await expect(
        submitInvoice(
          server,
          INVOICE_ID as string,
          {
            payer: voter.publicKey(),
            amount: belowThreshold,
            token,
            discountRate: 300,
            dueDate,
          },
          proposerAccount,
          signWith(proposer),
          NETWORK_PASSPHRASE,
        ),
      ).rejects.toThrow();
    }, 240_000);
  },
);
