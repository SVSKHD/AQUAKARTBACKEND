import assert from "node:assert/strict";
import test from "node:test";
import AquaInvoice from "../src/models/crm/invoice.js";
import {
  areaFromAddress,
  getRecentDemand,
  parseDemandQuery,
} from "../src/services/storefrontDemand.js";

const stub = (t, { invoices = [], trending = [] } = {}) => {
  const calls = { find: [], aggregate: [] };
  t.mock.method(AquaInvoice, "find", (query) => {
    calls.find.push(query);
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
  t.mock.method(AquaInvoice, "aggregate", (pipeline) => {
    calls.aggregate.push(pipeline);
    return { option: async () => trending };
  });
  return calls;
};

test("picks the locality out of a free-text address", () => {
  assert.equal(
    areaFromAddress(
      "Flat 4, Lake View Apts, Kondapur, Hyderabad, Telangana 500084",
    ),
    "Kondapur",
  );
  assert.equal(
    areaFromAddress("plot 12\nMADHAPUR\nHyderabad - 500081"),
    "Madhapur",
  );
  assert.equal(
    areaFromAddress("H.No 1-2-3, Road No 5, Hyderabad"),
    "Hyderabad",
  );
  assert.equal(areaFromAddress(""), null);
});

test("clamps query values and trims the area", () => {
  assert.deepEqual(
    parseDemandQuery({ area: "  Kondapur  ", limit: "500", days: "0" }),
    {
      area: "Kondapur",
      limit: 20,
      days: 1,
    },
  );
  assert.deepEqual(parseDemandQuery({ limit: "abc" }), {
    area: "",
    limit: 10,
    days: 30,
  });
});

test("returns anonymous recent lines and trending products", async (t) => {
  const calls = stub(t, {
    invoices: [
      {
        createdAt: new Date("2026-10-27T10:42:13Z"),
        customerDetails: {
          name: "Ravi",
          phone: 9876543210,
          address: "12, Green Homes, Gachibowli, Hyderabad 500032",
        },
        invoiceNo: "AQ-1",
        products: [
          {
            productName: " Kent  Softener ",
            productQuantity: 2,
            productId: "p1",
            productSlug: "kent",
          },
          { productName: "Kent  Softener", productId: "p1" },
          { productName: "Salt 10kg" },
        ],
      },
    ],
    trending: [
      {
        productName: "Kent Softener",
        productId: "p1",
        orders: 3,
        units: 4,
        lastPurchasedAt: new Date("2026-10-27T10:42:13Z"),
      },
    ],
  });
  const now = new Date("2026-10-28T00:00:00Z");
  const data = await getRecentDemand({ area: "", limit: 10, days: 30 }, now);

  const q = calls.find[0];
  assert.deepEqual(q.quotation, { $ne: true });
  assert.equal(q.createdAt.$gte.toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(q["customerDetails.address"], undefined);
  assert.doesNotMatch(calls.select, /name|phone|email|invoiceNo/);

  assert.deepEqual(data.recent, [
    {
      productName: "Kent Softener",
      productSlug: "kent",
      productId: "p1",
      quantity: 2,
      area: "Gachibowli",
      purchasedAt: "2026-10-27T10:00:00.000Z",
    },
    {
      productName: "Salt 10kg",
      productSlug: null,
      productId: null,
      quantity: 1,
      area: "Gachibowli",
      purchasedAt: "2026-10-27T10:00:00.000Z",
    },
  ]);
  assert.equal(JSON.stringify(data).includes("Ravi"), false);
  assert.equal(JSON.stringify(data).includes("9876543210"), false);
  assert.deepEqual(data.trending[0], {
    productName: "Kent Softener",
    productSlug: null,
    productId: "p1",
    orders: 3,
    units: 4,
    lastPurchasedAt: "2026-10-27T10:00:00.000Z",
  });
});

test("filters by area with an escaped, case-insensitive match", async (t) => {
  const calls = stub(t);
  const data = await getRecentDemand({
    area: "kondapur (west)",
    limit: 5,
    days: 7,
  });
  assert.deepEqual(calls.find[0]["customerDetails.address"], {
    $regex: "kondapur \\(west\\)",
    $options: "i",
  });
  assert.equal(
    calls.aggregate[0][0].$match["customerDetails.address"].$regex,
    "kondapur \\(west\\)",
  );
  assert.equal(data.area, "Kondapur (West)");
  assert.deepEqual(data.recent, []);
});
