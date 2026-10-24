import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDraftPatch,
  buildItem,
  draftTotals,
  emptyDraft,
  toInvoicePayload,
  validateDraft,
} from "../src/services/aiInvoice/draft.js";
import { validateInvoicePayload } from "../src/controllers/crm/invoice.js";

const PRODUCT = {
  productId: "6a6ff135aafb698d0de9966b",
  name: "AquaKart Softener 25L",
  slug: "softener-25l",
  sellingPrice: 25000,
};

const fields = (list) => list.map((entry) => entry.field);

const readyDraft = () => {
  const { draft } = applyDraftPatch(emptyDraft(), {
    customerName: "Ravi Kumar",
    customerPhone: "+91 98765 43210",
    customerEmail: "Ravi@Example.com",
    customerAddress: "Kondapur, Hyderabad",
    paidStatus: "Paid",
    paymentType: "UPI",
  });
  draft.items.push(buildItem({ product: PRODUCT, quantity: 1 }));
  return draft;
};

test("flags invalid phone and email with the offending value", () => {
  const { draft } = applyDraftPatch(emptyDraft(), {
    customerName: "Ravi",
    customerPhone: "98765",
    customerEmail: "ravi@",
  });
  const { ready, errors } = validateDraft(draft);
  assert.equal(ready, false);
  assert.match(
    errors.find((e) => e.field === "customerPhone").message,
    /"98765" is not a valid Indian mobile/,
  );
  assert.ok(fields(errors).includes("customerEmail"));
  assert.ok(fields(errors).includes("items"));
});

test("GST invoices need a valid GSTIN and business name", () => {
  const draft = readyDraft();
  const { draft: gstDraft } = applyDraftPatch(draft, {
    gst: true,
    gstNo: "36abcde1234f1z",
  });
  const { errors } = validateDraft(gstDraft);
  assert.deepEqual(fields(errors).sort(), ["gstName", "gstNo"]);

  const { draft: fixed } = applyDraftPatch(gstDraft, {
    gstNo: "36 abcde1234f1z5",
    gstName: "Ravi Traders",
    gstAddress: "Hyderabad",
  });
  assert.equal(fixed.gstDetails.gstNo, "36ABCDE1234F1Z5");
  assert.equal(validateDraft(fixed).ready, true);
});

test("checks CRM stock and missing stock records", () => {
  const draft = readyDraft();
  draft.items[0].quantity = 3;
  assert.match(
    validateDraft(draft, { stock: new Map([[PRODUCT.productId, 2]]) }).errors[0]
      .message,
    /only 2 in CRM stock, but 3 needed/,
  );
  assert.match(
    validateDraft(draft, { stock: new Map([[PRODUCT.productId, null]]) })
      .errors[0].message,
    /no CRM stock record/,
  );
  assert.equal(
    validateDraft(draft, { stock: new Map([[PRODUCT.productId, 10]]) }).ready,
    true,
  );
});

test("warns about price drift, custom items and missing payment info", () => {
  const { draft } = applyDraftPatch(emptyDraft(), {
    customerName: "Ravi",
    customerPhone: "9876543210",
  });
  draft.items.push(
    buildItem({ product: PRODUCT, quantity: 1, unitPrice: 15000 }),
  );
  draft.items.push(
    buildItem({ name: "Installation", quantity: 1, unitPrice: 500 }),
  );
  const { ready, warnings } = validateDraft(draft);
  assert.equal(ready, true);
  const text = warnings.map((w) => w.message).join("\n");
  assert.match(text, /differs from the catalog price/);
  assert.match(text, /custom item/);
  assert.match(text, /Payment status not set/);
  assert.match(text, /No email/);
});

test("totals are GST-inclusive and payload passes the CRM validator", () => {
  const draft = readyDraft();
  draft.items.push(
    buildItem({ name: "Installation", quantity: 2, unitPrice: 590 }),
  );
  assert.deepEqual(draftTotals(draft), {
    itemCount: 2,
    total: 26180,
    taxableValue: 22186.44,
    gstAmount: 3993.56,
    pricesIncludeGst: true,
  });

  const payload = toInvoicePayload(draft);
  assert.equal(payload.customerDetails.phone, 9876543210);
  assert.equal(payload.customerDetails.email, "ravi@example.com");
  assert.equal(payload.products[0].productId, PRODUCT.productId);
  assert.equal(payload.products[0].productPrice, 25000);
  assert.equal(
    payload.products[0].productLink,
    "https://aquakart.co.in/product/softener-25l",
  );
  assert.equal(payload.products[1].productId, undefined);
  assert.equal(validateInvoicePayload(payload).isValid, true);
});
