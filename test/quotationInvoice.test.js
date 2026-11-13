import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceLineValues,
  mapQuotationToInvoicePayload,
  quotationLineTotal,
} from "../src/services/quotation/quotationInvoice.js";
import { validateInvoicePayload } from "../src/controllers/crm/invoice.js";

const PRODUCT_ID = "64b7f0c2a1b2c3d4e5f60718";

const quotation = (overrides = {}) => ({
  _id: "65a1b2c3d4e5f60718293a4b",
  quotationNo: "AQUO|20261113|0001",
  customerDetails: {
    name: "Ravi",
    phone: 9876543210,
    email: "ravi@example.com",
    address: "Hyderabad",
  },
  gst: false,
  products: [
    {
      productId: PRODUCT_ID,
      productName: "Softener",
      productQuantity: 2,
      productPrice: 10000,
      productDiscount: 1000,
      productTax: 0,
      productSerialNo: "SN1",
    },
    {
      productId: "custom-plumbing",
      productName: "Plumbing",
      productQuantity: 1,
      productPrice: 1000,
    },
  ],
  discount: 0,
  tax: 0,
  ...overrides,
});

test("line total is qty x price minus discount plus tax", () => {
  assert.equal(
    quotationLineTotal({
      productQuantity: 3,
      productPrice: 100,
      productDiscount: 50,
      productTax: 18,
    }),
    268,
  );
  assert.equal(
    quotationLineTotal({
      productQuantity: 1,
      productPrice: 10,
      productDiscount: 50,
    }),
    0,
  );
});

test("invoice productPrice is the line value, not the unit price", () => {
  const payload = mapQuotationToInvoicePayload(quotation());
  assert.deepEqual(
    payload.products.map((p) => [p.productQuantity, p.productPrice]),
    [
      [2, 19000],
      [1, 1000],
    ],
  );
});

test("quotation-level discount and tax are spread so totals match", () => {
  const q = quotation({ discount: 1000, tax: 333.33 });
  const values = invoiceLineValues(q);
  const total = values.reduce((sum, v) => sum + v, 0);
  assert.equal(Math.round(total * 100) / 100, 19333.33);
  assert.ok(values[0] > values[1]);
});

test("quotation tax with zero-value lines lands on the first line", () => {
  const q = quotation({
    products: [{ productName: "Visit", productQuantity: 1, productPrice: 0 }],
    tax: 100,
  });
  assert.deepEqual(invoiceLineValues(q), [100]);
});

test("maps flags, links the quotation and keeps quotation=false", () => {
  const payload = mapQuotationToInvoicePayload(quotation(), {
    po: true,
    paidStatus: "PAID",
    paymentType: "upi",
  });
  assert.equal(payload.po, true);
  assert.equal(payload.quotation, false);
  assert.equal(payload.paidStatus, "paid");
  assert.equal(payload.paymentType, "upi");
  assert.equal(payload.sourceQuotationNo, "AQUO|20261113|0001");
  assert.equal(payload.products[0].productId, PRODUCT_ID);
  assert.equal("productId" in payload.products[1], false);
  assert.equal(payload.productId, PRODUCT_ID);
  assert.deepEqual(payload.gstDetails, {});
});

test("unknown payment values fall back to unpaid / cash", () => {
  const payload = mapQuotationToInvoicePayload(quotation(), {
    paidStatus: "maybe",
    paymentType: "barter",
  });
  assert.equal(payload.po, false);
  assert.equal(payload.paidStatus, "unpaid");
  assert.equal(payload.paymentType, "cash");
});

test("GST details carry over and the payload passes invoice validation", () => {
  const payload = mapQuotationToInvoicePayload(
    quotation({
      gst: true,
      gstDetails: { gstName: "Ravi Traders", gstNo: "36AAAAA0000A1Z5" },
    }),
  );
  assert.equal(payload.gst, true);
  assert.equal(payload.gstDetails.gstName, "Ravi Traders");
  assert.equal(validateInvoicePayload(payload).isValid, true);
});

test("an invalid phone is reported by invoice validation", () => {
  const payload = mapQuotationToInvoicePayload(
    quotation({ customerDetails: { name: "Ravi", phone: 12345 } }),
  );
  const { isValid, errors } = validateInvoicePayload(payload);
  assert.equal(isValid, false);
  assert.ok(errors["customerDetails.phone"]);
});
