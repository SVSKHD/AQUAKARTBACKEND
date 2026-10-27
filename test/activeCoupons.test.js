import assert from "node:assert/strict";
import test from "node:test";
import Coupon from "../src/models/coupon.js";
import controller from "../src/controllers/coupon.js";

const stubFind = (t, rows = []) => {
  const calls = [];
  t.mock.method(Coupon, "find", (query) => {
    calls.push(query);
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      maxTimeMS: () => chain,
      lean: async () => rows,
    };
    return chain;
  });
  return calls;
};

const run = async () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await controller.getActiveCoupons({}, res);
  return res;
};

test("lists active, in-date, public coupons with only public fields", async (t) => {
  const calls = stubFind(t, [
    {
      _id: "c1",
      code: "PURE10",
      discountType: "percentage",
      discountValue: 10,
      maxDiscount: 1500,
      minimumOrder: 5000,
      endsAt: "2026-12-31",
      productIds: ["p1"],
      categoryIds: [],
      usageLimit: 100,
      usageCount: 3,
      createdBy: "admin",
    },
    {
      _id: "c2",
      code: "GONE",
      discountValue: 500,
      usageLimit: 5,
      usageCount: 5,
    },
  ]);
  const res = await run();

  const q = calls[0];
  assert.equal(q.status, "active");
  assert.ok(q.startsAt.$lte instanceof Date);
  assert.ok(q.endsAt.$gte instanceof Date);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.data.map((c) => c.code),
    ["PURE10"],
  );
  assert.equal(res.body.data[0].maxDiscount, 1500);
  assert.deepEqual(res.body.data[0].productIds, ["p1"]);
  assert.equal(res.body.data[0].createdBy, undefined);
  assert.equal(res.body.data[0].usageCount, undefined);
});
