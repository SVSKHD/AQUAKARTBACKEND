import assert from "node:assert/strict";
import test from "node:test";
import AquaInvoice from "../src/models/crm/invoice.js";
import {
  getDemandByArea,
  parseAreaQuery,
} from "../src/services/storefrontDemand.js";

const stubFind = (t, invoices) => {
  const calls = {};
  t.mock.method(AquaInvoice, "find", (query) => {
    calls.query = query;
    const chain = {
      select: (fields) => {
        calls.select = fields;
        return chain;
      },
      sort: () => chain,
      limit: () => chain,
      maxTimeMS: () => chain,
      lean: async () => invoices,
    };
    return chain;
  });
  return calls;
};

const inv = (address, names, at = "2026-11-01T10:20:00Z") => ({
  createdAt: new Date(at),
  customerDetails: { address, name: "Secret Person", phone: "9999999999" },
  products: names.map((n) => ({ productName: n, productQuantity: 1 })),
});

test("counts orders per locality with its most-bought products", async (t) => {
  const calls = stubFind(t, [
    inv("Flat 1, Kondapur, Hyderabad", ["Kent Automatic Water Softener 25"]),
    inv("Villa 9, Kondapur, Hyderabad", [
      "Kent Automatic Water Softener 25",
      "Kent Iron Filter",
    ]),
    inv("12, Gachibowli, Hyderabad 500032", ["Kent Iron Filter"]),
    // Only the city: can't be placed on a map, so left out.
    inv("H.No 1-2-3, Road No 5, Hyderabad", ["Kent Sandfilter"]),
  ]);
  const data = await getDemandByArea(
    { days: 90 },
    new Date("2026-11-09T00:00:00Z"),
  );
  assert.equal(calls.select, "createdAt customerDetails.address products");
  assert.equal(calls.query.quotation.$ne, true);
  assert.deepEqual(
    data.areas.map((a) => [a.area, a.orders]),
    [
      ["Kondapur", 2],
      ["Gachibowli", 1],
    ],
  );
  assert.deepEqual(
    data.areas[0].top.map((p) => [p.productName, p.orders]),
    [
      ["Kent Automatic Water Softener 25", 2],
      ["Kent Iron Filter", 1],
    ],
  );
  assert.equal(data.areas[0].lastPurchasedAt, "2026-11-01T10:00:00.000Z");
  // Nothing personal leaves the service.
  const json = JSON.stringify(data);
  assert.ok(!/Secret|9999|Flat 1|Villa 9/.test(json));
});

test("clamps the window", () => {
  assert.deepEqual(parseAreaQuery({}), { days: 90 });
  assert.deepEqual(parseAreaQuery({ days: "999" }), { days: 90 });
  assert.deepEqual(parseAreaQuery({ days: "7" }), { days: 7 });
});
