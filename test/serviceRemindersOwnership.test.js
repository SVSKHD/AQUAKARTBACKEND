import assert from "node:assert/strict";
import test from "node:test";
import AquaInvoice from "../src/models/crm/invoice.js";
import AquaProduct from "../src/models/product.js";
import controller from "../src/controllers/serviceReminders.js";

const run = async (t, user) => {
  const queries = [];
  t.mock.method(AquaInvoice, "find", (query) => {
    queries.push(query);
    return { sort: () => ({ lean: async () => [] }) };
  });
  t.mock.method(AquaProduct, "find", () => ({ lean: async () => [] }));
  const res = {
    body: null,
    status() {
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await controller.listMine({ user }, res);
  return { queries, res };
};

test("matches the Google account and its verified email, never the phone", async (t) => {
  const { queries } = await run(t, {
    firebaseUid: "uid-1",
    emailVerified: true,
    email: "Asha@X.in",
    phone: 9876543210,
  });
  const { $or } = queries[0];
  assert.deepEqual($or[0], { firebaseUid: "uid-1" });
  assert.equal($or[1].customerEmailNormalized, "asha@x.in");
  assert.ok($or[1].$or.some((c) => c.firebaseUid === null));
  assert.equal(JSON.stringify(queries[0]).includes("9876543210"), false);
  assert.equal($or.length, 2);
});

test("a phone or unverified email alone finds nothing", async (t) => {
  const { queries, res } = await run(t, {
    email: "asha@x.in",
    emailVerified: false,
    phone: 9876543210,
  });
  assert.equal(queries.length, 0);
  assert.deepEqual(res.body, { success: true, data: [] });
});
