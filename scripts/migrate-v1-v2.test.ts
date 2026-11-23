import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type InvoiceV1,
  assertV1Layout,
  migrateV1State,
} from "./migrate-v1-v2.ts";

const representativeV1: InvoiceV1[] = [
  {
    id: 1,
    freelancer: "GFREELANCER0",
    payer: "GPAYER0",
    amount: 1n,
    due_date: 1_700_000_000,
    discount_rate: 0,
    status: "Pending",
    amount_funded: 0n,
    amount_paid: 0n,
  },
  {
    id: 2,
    freelancer: "GFREELANCER1",
    payer: "GPAYER1",
    amount: 500_000_000_000_000n,
    due_date: 1_900_000_000,
    discount_rate: 2500,
    status: "Paid",
    amount_funded: 500_000_000_000_000n,
    amount_paid: 500_000_000_000_000n,
  },
  {
    id: 3,
    freelancer: "GFREELANCER0",
    payer: "GPAYER2",
    amount: 1_000_000n,
    due_date: 1_800_000_000,
    discount_rate: 1200,
    status: "Defaulted",
    amount_funded: 1_000_000n,
    amount_paid: 400_000n,
  },
];

test("representative v1 fixture migrates with correct v2 defaults", () => {
  const before = structuredClone(representativeV1);
  const after = migrateV1State(representativeV1, { GFREELANCER1: 87 });

  assert.equal(after.length, 3);
  assert.deepEqual(representativeV1, before);
  assert.equal(after[0]!.submitter_reputation, 50);
  assert.equal(after[1]!.submitter_reputation, 87);
  assert.equal(after[2]!.submitter_reputation, 50);
  for (const invoice of after) {
    assert.equal(invoice.allowed_lps, null);
    assert.equal(invoice.is_auction, false);
  }
});

test("unsupported v2 layout fails before any row is transformed", () => {
  const alreadyMigrated = {
    ...representativeV1[0]!,
    submitter_reputation: 42,
    allowed_lps: null,
    is_auction: false,
  };
  const before = structuredClone(alreadyMigrated);

  assert.throws(
    () => migrateV1State([representativeV1[0]!, alreadyMigrated, representativeV1[1]!], {}),
    /already migrated/
  );
  assert.deepEqual(alreadyMigrated, before);
});

test("malformed and unsupported status layouts fail closed", () => {
  assert.throws(() => assertV1Layout({ id: 1, status: "Pending" }), /freelancer must be string/);
  assert.throws(
    () => assertV1Layout({ ...representativeV1[0]!, status: "Disputed" }),
    /unsupported status/
  );
});
