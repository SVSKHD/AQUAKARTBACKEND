import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuickDraft,
  normalizeExtraction,
  numbersInText,
  rankCatalog,
} from "../src/services/aiInvoice/quickDraft.js";

const CATALOG = [
  {
    productId: "6a6ff135aafb698d0de9966b",
    name: "Aquakart Bathroom Water Softener",
    brand: "Aquakart",
    slug: "bathroom-softener",
    sellingPrice: 15500,
  },
  {
    productId: "6a6ff135aafb698d0de9966c",
    name: "Whole House Water Softener 1000 LPH",
    brand: "Aquakart",
    slug: "whole-house-softener",
    sellingPrice: 45000,
  },
  {
    productId: "6a6ff135aafb698d0de9966d",
    name: "RO Water Purifier 12L",
    brand: "Kent",
    slug: "ro-12l",
    sellingPrice: 12000,
  },
];

const SOURCE =
  "Ravi Kumar 98765 43210\nKondapur 500084\nbathroo softener 14,950";

const fakeGenerate = (extraction, picks) => {
  const calls = [];
  const generate = async (options) => {
    calls.push(options);
    const isPick = /candidates list/.test(options.systemInstruction);
    return { text: JSON.stringify(isPick ? picks : extraction) };
  };
  return { generate, calls };
};

const deps = (
  generate,
  stock = new Map([["6a6ff135aafb698d0de9966b", 5]]),
) => ({
  generate,
  loadCatalog: async () => CATALOG,
  loadStock: async () => stock,
});

test("numbersInText reads commas and k suffixes", () => {
  assert.deepEqual(numbersInText("Rs 14,950/- x2, 15k"), [14950, 2, 15000]);
});

test("no quantity means 1; a written quantity is used", () => {
  const draft = normalizeExtraction(
    {
      products: [
        { productName: "bathroo softener", quantity: null, unitPrice: 14950 },
        { productName: "ro purifier", quantity: 2, unitPrice: 12000 },
      ],
    },
    "bathroo softener 14950\nro purifier 2 12000",
  );
  assert.equal(draft.products[0].quantity, 1);
  assert.equal(draft.products[0].quantityAssumed, true);
  assert.equal(draft.products[1].quantity, 2);
  assert.equal(draft.products[1].quantityAssumed, false);
});

test("a price that was not written is reported missing, never invented", () => {
  const draft = normalizeExtraction(
    {
      products: [
        { productName: "bathroo softener", quantity: null, unitPrice: null },
        { productName: "ro purifier", quantity: 1, unitPrice: 12000 },
      ],
    },
    "bathroo softener\nro purifier 9999",
  );
  assert.equal(draft.products[0].priceMissing, true);
  assert.equal(draft.products[0].unitPrice, null);
  // 12000 does not appear in the text, so it is rejected too.
  assert.equal(draft.products[1].priceMissing, true);
});

test("phone and email must appear in the pasted text", () => {
  const draft = normalizeExtraction(
    { phone: "9123456789", email: "x@y.com" },
    "call 98765 43210",
  );
  assert.equal(draft.customer.phone, "");
  assert.equal(draft.customer.email, "");
  assert.equal(draft.warnings.length, 2);
});

test("typos and partial words match the right product", () => {
  const typo = rankCatalog("bathroo softner", CATALOG);
  assert.equal(typo.confidence, "high");
  assert.equal(typo.candidates[0].product.slug, "bathroom-softener");

  const none = rankCatalog("garden hose", CATALOG);
  assert.equal(none.confidence, "none");
});

test("a name that fits several products is ambiguous", () => {
  const { confidence, candidates } = rankCatalog("water softener", CATALOG);
  assert.equal(confidence, "low");
  assert.equal(candidates.length, 2);
});

test("buildQuickDraft: matched line, typed price kept, stock checked", async () => {
  const { generate, calls } = fakeGenerate({
    name: "Ravi Kumar",
    phone: "9876543210",
    address: "Kondapur, 500084",
    products: [
      { productName: "bathroo softener", quantity: null, unitPrice: 14950 },
    ],
  });
  const draft = await buildQuickDraft(SOURCE, deps(generate));
  assert.equal(calls.length, 1, "no pick call for a clear match");
  const [item] = draft.items;
  assert.equal(item.match.productId, "6a6ff135aafb698d0de9966b");
  assert.equal(item.match.catalogPrice, 15500);
  assert.equal(item.match.stock, 5);
  assert.equal(item.unitPrice, 14950);
  assert.equal(item.quantity, 1);
  assert.equal(item.lineTotal, 14950);
  assert.equal(draft.totals.total, 14950);
  assert.equal(draft.validation.ready, true);
});

test("buildQuickDraft: missing price is a blocking error", async () => {
  const { generate } = fakeGenerate({
    name: "Ravi Kumar",
    phone: "9876543210",
    products: [
      { productName: "bathroo softener", quantity: null, unitPrice: null },
    ],
  });
  const draft = await buildQuickDraft(
    "Ravi Kumar 9876543210 bathroo softener",
    deps(generate),
  );
  assert.equal(draft.validation.ready, false);
  const priceErrors = draft.validation.errors.filter(
    (e) => e.field === "items.1",
  );
  assert.equal(priceErrors.length, 1);
  assert.equal(priceErrors[0].code, "PRICE_MISSING");
});

test("buildQuickDraft: AI may only pick one of the candidates", async () => {
  const source = "Ravi 9876543210 water softener 14950";
  const extraction = {
    name: "Ravi",
    phone: "9876543210",
    products: [
      { productName: "water softener", quantity: null, unitPrice: 14950 },
    ],
  };

  const bad = fakeGenerate(extraction, {
    picks: [{ line: 1, productId: "000000000000000000000000" }],
  });
  const rejected = await buildQuickDraft(source, deps(bad.generate));
  assert.equal(bad.calls.length, 2);
  assert.equal(rejected.items[0].match, null);
  assert.equal(rejected.items[0].confidence, "none");
  assert.equal(rejected.items[0].alternatives.length, 2);

  const good = fakeGenerate(extraction, {
    picks: [{ line: 1, productId: "6a6ff135aafb698d0de9966c" }],
  });
  const picked = await buildQuickDraft(source, deps(good.generate));
  assert.equal(picked.items[0].match.productId, "6a6ff135aafb698d0de9966c");
  assert.equal(picked.items[0].confidence, "ai");
});

test("buildQuickDraft: a failed pick keeps the top candidate for review", async () => {
  let call = 0;
  const generate = async () => {
    call += 1;
    if (call === 2) throw new Error("busy");
    return {
      text: JSON.stringify({
        name: "Ravi",
        phone: "9876543210",
        products: [
          { productName: "water softener", quantity: null, unitPrice: 14950 },
        ],
      }),
    };
  };
  const draft = await buildQuickDraft(
    "Ravi 9876543210 water softener 14950",
    deps(generate),
  );
  assert.equal(draft.items[0].confidence, "low");
  assert.ok(draft.items[0].match);
});
