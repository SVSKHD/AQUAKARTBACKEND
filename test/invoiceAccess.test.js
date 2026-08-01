import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateInvoiceTotal,
  hashToken,
  maskEmail,
  normalizeEmail,
  normalizeIndianPhone,
  signInvoiceAccessToken,
  verifyInvoiceAccessToken,
} from "../src/utils/invoiceAccess.js";

test("normalizes supported Indian phone formats", () => {
  assert.equal(normalizeIndianPhone("+91 98765-43210"), "9876543210");
  assert.equal(normalizeIndianPhone("919876543210"), "9876543210");
  assert.equal(normalizeIndianPhone("12345"), "");
});

test("normalizes and masks customer email", () => {
  assert.equal(
    normalizeEmail(" Customer@Example.COM "),
    "customer@example.com",
  );
  assert.equal(maskEmail("customer@example.com"), "cu******@e***.com");
  assert.equal(maskEmail("invalid"), "");
});

test("hashes opaque tokens without retaining the input", () => {
  const hash = hashToken("secret-token");
  assert.equal(hash.length, 64);
  assert.notEqual(hash, "secret-token");
});

test("signs invoice-scoped access tokens", () => {
  process.env.INVOICE_ACCESS_SECRET =
    "test-invoice-secret-with-sufficient-length";
  const token = signInvoiceAccessToken({
    invoiceIds: ["507f1f77bcf86cd799439011"],
    email: "customer@example.com",
    firebaseUid: "firebase-customer-1",
  });
  const payload = verifyInvoiceAccessToken(token);
  assert.equal(payload.purpose, "invoice-access");
  assert.deepEqual(payload.invoiceIds, ["507f1f77bcf86cd799439011"]);
  assert.equal(payload.firebaseUid, "firebase-customer-1");
});

test("calculates invoice totals from quantity and price", () => {
  assert.equal(
    calculateInvoiceTotal({
      products: [
        { productPrice: 1000, productQuantity: 2 },
        { productPrice: 500, productQuantity: 1 },
      ],
    }),
    2500,
  );
});
