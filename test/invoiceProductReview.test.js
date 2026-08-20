import assert from "node:assert/strict";
import test from "node:test";
import { invoiceContainsProduct } from "../src/utils/invoiceProductReview.js";

test("matches an invoice product by persisted product id", () => {
  assert.equal(
    invoiceContainsProduct({
      invoice: {
        products: [{ productId: "product-1", productName: "Old label" }],
      },
      product: { _id: "product-1", title: "New label" },
    }),
    true,
  );
});

test("matches legacy invoice products by normalized exact title", () => {
  assert.equal(
    invoiceContainsProduct({
      invoice: { products: [{ productName: "Aquaguard & RO 7L" }] },
      product: { _id: "product-2", title: "Aquaguard and RO 7L" },
    }),
    true,
  );
});

test("matches legacy titles with harmless catalogue wording differences", () => {
  assert.equal(
    invoiceContainsProduct({
      invoice: { products: [{ productName: "Aquakart Kent Grand RO 8L" }] },
      product: { _id: "product-2", title: "Kent Grand RO 8L Purifier" },
    }),
    true,
  );
});

test("rejects products with conflicting model numbers", () => {
  assert.equal(
    invoiceContainsProduct({
      invoice: { products: [{ productName: "Kent Grand RO 8L" }] },
      product: { _id: "product-2", title: "Kent Grand RO 12L" },
    }),
    false,
  );
});

test("rejects unrelated catalogue products", () => {
  assert.equal(
    invoiceContainsProduct({
      invoice: { products: [{ productName: "Aquaguard RO 7L" }] },
      product: { _id: "product-3", title: "Water Softener 25L" },
    }),
    false,
  );
});
