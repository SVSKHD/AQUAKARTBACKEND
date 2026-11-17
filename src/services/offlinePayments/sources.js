import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";
import { mapQuotationToInvoicePayload } from "../quotation/quotationInvoice.js";
import { money } from "./rules.js";

// One adapter per payable document kind. Link, public, initiate, webhook
// and status code call only these functions and never branch on the kind:
//   load(id)                 the document, or null
//   isPayable(doc)           { ok, reason }
//   payableSnapshot(doc)     lines, subTotal, discount, tax, total, currency,
//                            phone, number (the only source of the amount)
//   markPaid(doc, payment)   record the verified payment (idempotent)
// and two conversion hooks used after payment:
//   invoicePayload(doc, opts) payload for the existing invoice writer
//   attachInvoice(doc, invoice) link the final invoice to the document

const QUOTATION_UNPAYABLE = new Set([
  "Paid",
  "Converted",
  "Sold",
  "Rejected",
  "Expired",
]);
const PRE_INVOICE_PAYABLE = new Set(["Draft", "Payment Pending"]);

const lineSnapshot = (doc) =>
  (Array.isArray(doc.products) ? doc.products : []).map((line) => ({
    productId: line.productId ? String(line.productId) : null,
    name: String(line.productName || "").trim(),
    description: String(line.productDescription || "").trim(),
    quantity: Number(line.productQuantity) || 0,
    price: money(line.productPrice),
    discount: money(line.productDiscount),
    tax: money(line.productTax),
    total: money(line.productTotal),
  }));

const snapshotOf = (doc, number) => ({
  number,
  lines: lineSnapshot(doc),
  subTotal: money(doc.subTotal),
  discount: money(doc.discount),
  tax: money(doc.tax),
  total: money(doc.totalAmount),
  currency: String(doc.currency || "INR").toUpperCase(),
  phone: normalizeIndianPhone(doc.customerDetails?.phone),
});

const commonChecks = (doc) => {
  if (!doc) return { ok: false, reason: "NOT_FOUND" };
  if (doc.payment?.status === "Paid")
    return { ok: false, reason: "ALREADY_PAID" };
  if (doc.convertedToInvoice) return { ok: false, reason: "ALREADY_INVOICED" };
  if (!(money(doc.totalAmount) > 0)) return { ok: false, reason: "ZERO_TOTAL" };
  if (String(doc.currency || "INR").toUpperCase() !== "INR")
    return { ok: false, reason: "UNSUPPORTED_CURRENCY" };
  return { ok: true };
};

const paymentSet = (payment, status) => ({
  status,
  "payment.status": "Paid",
  "payment.amountPaid": payment.amount,
  "payment.transactionId": payment.transactionId,
  "payment.paidAt": payment.paidAt,
  "payment.mode": payment.mode,
});

export const createSourceAdapters = ({ store, now = () => new Date() }) => {
  const markPaidWith =
    (kind, extra = {}) =>
    async (doc, payment) => {
      const updated = await store.updateSource(
        kind,
        doc._id,
        { "payment.status": { $ne: "Paid" } },
        { $set: { ...paymentSet(payment, "Paid"), ...extra } },
      );
      return updated || store.findSource(kind, doc._id);
    };

  const quotation = {
    kind: "quotation",
    load: (id) => store.findSource("quotation", id),
    number: (doc) => doc.quotationNo || "",
    isPayable(doc) {
      const common = commonChecks(doc);
      if (!common.ok) return common;
      if (doc.convertedToPreInvoice)
        return { ok: false, reason: "MOVED_TO_PRE_INVOICE" };
      if (QUOTATION_UNPAYABLE.has(doc.status))
        return { ok: false, reason: `STATUS_${doc.status.toUpperCase()}` };
      return { ok: true };
    },
    payableSnapshot: (doc) => snapshotOf(doc, doc.quotationNo || ""),
    markPaid: markPaidWith("quotation", {
      "payment.balanceAmount": 0,
      "payment.notes": "Paid online via Aquakart payment link",
    }),
    markPending: (doc) =>
      store.updateSource(
        "quotation",
        doc._id,
        { status: { $in: ["Draft", "Sent", "Accepted"] } },
        { $set: { status: "Payment Pending" } },
      ),
    invoicePayload: (doc, { paymentType, fallbackAddress }) => {
      const payload = mapQuotationToInvoicePayload(doc, { paidStatus: "paid" });
      payload.paymentType = paymentType;
      if (!payload.customerDetails.address && fallbackAddress)
        payload.customerDetails.address = fallbackAddress;
      return payload;
    },
    // Same result as the CRM "convert to invoice" (markQuotationSold).
    attachInvoice: (doc, invoice) =>
      store.updateSource(
        "quotation",
        doc._id,
        {},
        {
          $set: {
            status: "Sold",
            convertedToInvoice: invoice._id,
            "whatsapp.followUpEnabled": false,
            "whatsapp.nextFollowUpAt": null,
            "whatsapp.stoppedAt": now(),
          },
        },
      ),
  };

  const preInvoice = {
    kind: "pre_invoice",
    load: (id) => store.findSource("pre_invoice", id),
    number: (doc) => doc.preInvoiceNo || "",
    isPayable(doc) {
      const common = commonChecks(doc);
      if (!common.ok) return common;
      if (!PRE_INVOICE_PAYABLE.has(doc.status))
        return { ok: false, reason: `STATUS_${doc.status.toUpperCase()}` };
      return { ok: true };
    },
    payableSnapshot: (doc) => snapshotOf(doc, doc.preInvoiceNo || ""),
    markPaid: markPaidWith("pre_invoice"),
    markPending: (doc) =>
      store.updateSource(
        "pre_invoice",
        doc._id,
        { status: "Draft" },
        { $set: { status: "Payment Pending" } },
      ),
    // Pre-invoice lines have the quotation shape, so the quotation mapping
    // (line values that add up to the total) is reused; the source links
    // point at the pre-invoice and its original quotation.
    invoicePayload: (doc, { paymentType, fallbackAddress }) => {
      const payload = mapQuotationToInvoicePayload(doc, { paidStatus: "paid" });
      payload.paymentType = paymentType;
      payload.sourcePreInvoiceId = doc._id;
      payload.sourcePreInvoiceNo = doc.preInvoiceNo || "";
      payload.sourceQuotationId = doc.sourceQuotationId || null;
      payload.sourceQuotationNo = doc.sourceQuotationNo || "";
      if (!payload.customerDetails.address && fallbackAddress)
        payload.customerDetails.address = fallbackAddress;
      return payload;
    },
    attachInvoice: async (doc, invoice) => {
      const updated = await store.updateSource(
        "pre_invoice",
        doc._id,
        {},
        { $set: { status: "Converted", convertedToInvoice: invoice._id } },
      );
      if (doc.sourceQuotationId)
        await store.updateSource(
          "quotation",
          doc.sourceQuotationId,
          { convertedToPreInvoice: doc._id },
          {
            $set: {
              status: "Sold",
              convertedToInvoice: invoice._id,
              "payment.status": "Paid",
              "payment.amountPaid": doc.payment?.amountPaid ?? doc.totalAmount,
              "payment.transactionId": doc.payment?.transactionId,
              "payment.paidAt": doc.payment?.paidAt,
            },
          },
        );
      return updated;
    },
  };

  return { quotation, pre_invoice: preInvoice };
};
