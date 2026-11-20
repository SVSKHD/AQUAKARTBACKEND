import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import publicInvoiceRoutes from "../src/routes/publicInvoice.js";
import AquaInvoice from "../src/models/crm/invoice.js";
import { maskFirstName, toInvoicePreview } from "../src/utils/invoiceAccess.js";

const ID = "6a6ff135aafb698d0de9966b";
const INVOICE = {
  _id: ID,
  invoiceNo: "AQBabc123|20112026",
  date: "2026-11-20",
  paidStatus: "paid",
  gst: false,
  po: false,
  quotation: false,
  customerDetails: {
    name: "Ravi Kumar",
    phone: 9876543210,
    email: "ravi@example.com",
    address: "Kondapur, Hyderabad",
  },
  products: [
    {
      productName: "Bathroom Softener",
      productQuantity: 1,
      productPrice: 14950,
      productSerialNo: "SN1",
    },
    { productName: "Filter", productQuantity: 2, productPrice: 1000 },
    { productName: "Tap", productQuantity: 1, productPrice: 500 },
    { productName: "Pipe", productQuantity: 3, productPrice: 300 },
  ],
};

test("maskFirstName shows only the start of the first name", () => {
  assert.equal(maskFirstName("Ravi Kumar"), "Ra•••");
  assert.equal(maskFirstName("Al"), "A•••");
  assert.equal(maskFirstName("  "), "");
});

test("toInvoicePreview returns only non-personal fields", () => {
  const preview = toInvoicePreview(INVOICE);
  assert.deepEqual(Object.keys(preview).sort(), [
    "customerName",
    "date",
    "documentType",
    "gst",
    "invoiceNo",
    "itemCount",
    "paidStatus",
    "products",
    "total_price",
  ]);
  assert.equal(preview.customerName, "Ra•••");
  assert.equal(preview.itemCount, 4);
  assert.equal(preview.products.length, 3);
  assert.deepEqual(preview.products[0], {
    name: "Bathroom Softener",
    quantity: 1,
  });
  // productPrice is the line value: the total is the plain sum.
  assert.equal(preview.total_price, 16750);
  assert.equal(preview.documentType, "invoice");
  const json = JSON.stringify(preview);
  for (const secret of [
    "9876543210",
    "ravi@example.com",
    "Kondapur",
    "SN1",
    "Kumar",
  ]) {
    assert.ok(!json.includes(secret), `preview leaks ${secret}`);
  }
  assert.equal(
    toInvoicePreview({ ...INVOICE, quotation: true }).documentType,
    "quotation",
  );
  assert.equal(
    toInvoicePreview({ ...INVOICE, po: true }).documentType,
    "purchase-order",
  );
});

const startApp = async (t) => {
  const app = express();
  app.use("/v1/invoices/public", publicInvoiceRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/v1/invoices/public`;
};

const findByIdReturning = (t, value) => {
  const calls = [];
  t.mock.method(AquaInvoice, "findById", (id) => {
    calls.push(id);
    const query = {
      select: (fields) => {
        calls.push(fields);
        return query;
      },
      lean: async () => value,
    };
    return query;
  });
  return calls;
};

test("GET /:id/preview works without an access token", async (t) => {
  const calls = findByIdReturning(t, INVOICE);
  const base = await startApp(t);
  const response = await fetch(`${base}/${ID}/preview`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.preview.invoiceNo, INVOICE.invoiceNo);
  assert.equal(body.preview.customerName, "Ra•••");
  // Only the needed fields are read from the database.
  assert.doesNotMatch(calls[1], /phone|email|address|gstDetails/);
});

test("GET /:id/preview: 404 for bad or unknown ids", async (t) => {
  findByIdReturning(t, null);
  const base = await startApp(t);
  assert.equal((await fetch(`${base}/not-an-id/preview`)).status, 404);
  assert.equal((await fetch(`${base}/${ID}/preview`)).status, 404);
});

test("GET /:id still requires invoice access", async (t) => {
  findByIdReturning(t, INVOICE);
  const base = await startApp(t);
  const response = await fetch(`${base}/${ID}`);
  assert.equal(response.status, 401);
});
