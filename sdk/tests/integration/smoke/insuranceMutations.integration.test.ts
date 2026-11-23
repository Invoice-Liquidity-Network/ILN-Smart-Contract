/**
 * Testnet smoke test for `enrollInsurancePool`.
 *
 * The testnet contract registry has no insurance pool address, so this suite needs
 * INSURANCE_POOL_ID (a deployed pool) in addition to TEST_SUBMITTER_SECRET, and is skipped
 * otherwise. A brand-new random LP is enrolled so the "not enrolled -> enrolled" transition
 * is deterministic and independent of earlier runs.
 *
 * `enrollInsurancePool` returns on submission, so the test polls `isEnrolled` for confirmed state.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { enrollInsurancePool, isEnrolled } from "../../../src/methods/insurance.js";
import {
  NETWORK_PASSPHRASE,
  fundWithFriendbot,
  keypairSignTx,
  testnetServer,
} from "../setup.js";
import { freshAccount } from "./helpers.js";

const POOL_ID = process.env["INSURANCE_POOL_ID"];
const describeOrSkip = POOL_ID ? describe : describe.skip;

describeOrSkip("insurance pool mutations smoke (testnet)", () => {
  const server = testnetServer();

  it("enrollInsurancePool: a fresh LP goes from not enrolled to enrolled on chain", async () => {
    const lp = Keypair.random();
    await fundWithFriendbot(lp.publicKey());

    expect(await isEnrolled(server, POOL_ID as string, lp.publicKey(), NETWORK_PASSPHRASE)).toBe(false);

    const { txHash } = await enrollInsurancePool(
      server,
      POOL_ID as string,
      lp.publicKey(),
      await freshAccount(lp),
      keypairSignTx(lp, server),
      NETWORK_PASSPHRASE
    );
    expect(txHash).toBeTruthy();

    const deadline = Date.now() + 60_000;
    let enrolled = false;
    while (Date.now() < deadline && !enrolled) {
      enrolled = await isEnrolled(server, POOL_ID as string, lp.publicKey(), NETWORK_PASSPHRASE);
      if (!enrolled) await new Promise((r) => setTimeout(r, 2_000));
    }
    expect(enrolled).toBe(true);
  }, 180_000);
});
