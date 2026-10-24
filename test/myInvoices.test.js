import assert from "node:assert/strict";
import test from "node:test";
import AquaInvoice from "../src/models/crm/invoice.js";
import publicInvoiceController from "../src/controllers/publicInvoice.js";

// Captures the query listMine builds and returns `rows` through the chain.
const stubFind = (t, rows = []) => {
  const calls = [];
  t.mock.method(AquaInvoice, "find", (query) => {
    calls.push(query);
    const chain = {
      sort: () => chain,
      limit: () => chain,
      maxTimeMS: () => chain,
      lean: async () => rows,
    };
    return chain;
  });
  return calls;
};

const run = async (user) => {
  const res = {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await publicInvoiceController.listMine({ user }, res);
  return res;
};

test("lists invoices bound to the account and unclaimed ones with the verified email", async (t) => {
  const calls = stubFind(t, [
    {
      _id: "inv1",
      invoiceNo: "AQ-101",
      date: "2026-10-01",
      paidStatus: "Paid",
      firebaseUid: "uid-1",
      products: [
        { productName: "Kent Automatic 8L", productPrice: 31500 },
        { productName: " Salt 10kg ", productPrice: 500 },
      ],
    },
  ]);
  const res = await run({
    firebaseUid: "uid-1",
    emailVerified: true,
    email: "A@Example.com",
  });

  const { $or } = calls[0];
  assert.deepEqual($or[0], { firebaseUid: "uid-1" });
  const [emailMatch, unclaimed] = $or[1].$and;
  assert.ok(
    emailMatch.$or.some((c) => c.customerEmailNormalized === "a@example.com"),
  );
  // Another account's invoice is never matched by email alone.
  assert.ok(
    unclaimed.$or.every(
      (c) =>
        !("firebaseUid" in c) ||
        c.firebaseUid === null ||
        c.firebaseUid === "" ||
        c.firebaseUid.$exists === false,
    ),
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.invoices[0], {
    id: "inv1",
    invoiceNo: "AQ-101",
    date: "2026-10-01",
    paidStatus: "Paid",
    itemCount: 2,
    total_price: 32000,
    canView: true,
    items: ["Kent Automatic 8L", "Salt 10kg"],
  });
});

test("does not match by email for accounts without a verified Google email", async (t) => {
  const calls = stubFind(t);
  await run({
    firebaseUid: "uid-2",
    emailVerified: false,
    email: "b@example.com",
  });
  assert.deepEqual(calls[0], { $or: [{ firebaseUid: "uid-2" }] });
});

test("returns nothing (and runs no query) for a non-Google account", async (t) => {
  const calls = stubFind(t);
  const res = await run({ email: "c@example.com", emailVerified: true });
  assert.equal(calls.length, 0);
  assert.deepEqual(res.body, { success: true, invoices: [] });
});
