import { createHash } from "node:crypto";
import { parseInvoicePurchaseDate } from "../serviceReminders.js";
import {
  getInvoiceProductPriceTotal,
  normalizeIndianPhone,
} from "../../utils/invoiceAccess.js";

// Pure rules of the MCP invoice data-quality audit: address classification,
// address-evidence ranking, duplicate scoring and stable issue identities.
// No database access; see invoiceAuditTools.js for how evidence is loaded.
// Every confidence below comes from these documented tables only
// (docs/MCP_INVOICE_AUDIT.md), never from a model's judgement.

const DAY_MS = 24 * 60 * 60 * 1000;

// Values staff type when they have no address. Compared after lowercasing
// and removing everything except letters and digits.
const PLACEHOLDERS = new Set([
  "na",
  "nil",
  "none",
  "null",
  "undefined",
  "notavailable",
  "notapplicable",
  "unknown",
  "tbd",
  "tba",
  "address",
  "noaddress",
  "xxx",
  "xx",
  "x",
  "0",
  "00",
  "000",
]);
// Fewer letters/digits than this is treated as possibly incomplete.
export const INCOMPLETE_MIN_CHARS = 12;

export const compactText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// "missing" (null/empty/whitespace), "placeholder" (N/A, -, nil…),
// "incomplete" (too short to be a deliverable address) or "ok".
export const classifyAddress = (value) => {
  if (value === null || value === undefined) return "missing";
  const text = String(value).trim();
  if (!text) return "missing";
  const compact = compactText(text);
  if (!compact || PLACEHOLDERS.has(compact)) return "placeholder";
  if (compact.length < INCOMPLETE_MIN_CHARS) return "incomplete";
  return "ok";
};
export const isAddressMissing = (value) =>
  ["missing", "placeholder"].includes(classifyAddress(value));

// Quotation and PO documents are compared only with their own kind, so a
// quotation and the invoice made from it are never paired as duplicates.
export const documentKind = (invoice = {}) => {
  if (invoice.quotation) return "quotation";
  if (invoice.po) return "po";
  return "invoice";
};

const plainObject = (value) =>
  value instanceof Map ? Object.fromEntries(value) : value || {};
const joinParts = (parts) =>
  parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ");

// Same field order the CRM uses when it creates an invoice from an order
// (src/controllers/crm/orderInvoice.js), without the user's *current*
// selected address, which may not be where this order went.
export const formatOrderAddress = (address) => {
  const value = plainObject(address);
  return (
    joinParts([
      value.street || value.address,
      value.city,
      value.state,
      value.postalCode || value.pincode,
    ]) || ""
  );
};
export const formatCrmOrderAddress = (order = {}) =>
  joinParts([order.address, order.city, order.pincode]);
export const formatUserAddress = (address = {}) =>
  joinParts([address.street, address.city, address.state, address.postalCode]);

// Evidence tiers, in priority order. Tier 1-2: the invoice's own source
// records; tier 3: the customer account the invoice is verifiably linked to
// (firebaseUid); tier 4: records that only share the phone number.
export const ADDRESS_SOURCES = {
  linked_order_shipping: { tier: 1, confidence: 0.95 },
  linked_order_billing: { tier: 1, confidence: 0.9 },
  linked_crm_order: { tier: 1, confidence: 0.95 },
  linked_quotation: { tier: 2, confidence: 0.9 },
  linked_account_address: { tier: 3, confidence: 0.75 },
  phone_account_address: { tier: 4, confidence: 0.5 },
  phone_invoice_history: { tier: 4, confidence: 0.45 },
};

export const candidateId = (value) =>
  `cand_${createHash("sha256").update(compactText(value)).digest("hex").slice(0, 16)}`;

// Ranks address candidates. Returns the suggestion (or null when a person
// must choose), the de-duplicated candidates and the reasoning.
// - tier 1/2 values that all agree -> suggested (confidence of best source)
// - tier 1/2 values that disagree -> conflict, no suggestion
// - otherwise tier 3/4: suggested only when every value on file is the same
//   address; several different addresses -> the reviewer must choose
export const rankAddressCandidates = (raw = []) => {
  const usable = raw
    .filter((item) => classifyAddress(item.value) === "ok")
    .map((item) => ({
      ...item,
      value: String(item.value).trim(),
      ...ADDRESS_SOURCES[item.source],
    }))
    .filter((item) => item.tier);
  const byValue = new Map();
  for (const item of usable.sort(
    (a, b) => a.tier - b.tier || b.confidence - a.confidence,
  )) {
    const key = compactText(item.value);
    const existing = byValue.get(key);
    if (existing) existing.sources.push(item.source);
    else
      byValue.set(key, {
        candidateId: candidateId(item.value),
        source: item.source,
        sources: [item.source],
        value: item.value,
        confidence: item.confidence,
        tier: item.tier,
        reference: item.reference || null,
      });
  }
  const candidates = [...byValue.values()].slice(0, 10);
  const strong = candidates.filter((item) => item.tier <= 2);
  const weak = candidates.filter((item) => item.tier > 2);
  const result = (suggested, reason, extra = {}) => ({
    suggested: suggested || null,
    confidence: suggested ? suggested.confidence : 0,
    reason,
    candidates: candidates.map(({ sources, ...item }) => ({
      ...item,
      sources,
    })),
    ...extra,
  });
  if (!candidates.length) return result(null, "no_evidence");
  if (strong.length === 1) return result(strong[0], `tier_${strong[0].tier}`);
  if (strong.length > 1)
    return result(null, "conflicting_linked_records", { conflict: true });
  if (weak.length === 1)
    return result(weak[0], `tier_${weak[0].tier}`, {
      requiresManualConfirmation: weak[0].tier === 4,
    });
  return result(null, "multiple_addresses_on_file", {
    requiresManualConfirmation: true,
  });
};

// ---- Duplicates ------------------------------------------------------

// Line-item identity: product id (or normalized name) and quantity.
export const productSignature = (invoice = {}) =>
  (Array.isArray(invoice.products) ? invoice.products : [])
    .map(
      (line) =>
        `${line?.productId ? String(line.productId) : compactText(line?.productName)}x${Number(line?.productQuantity) || 0}`,
    )
    .sort()
    .join("|");

// The existing invoice total (summed productPrice, as invoice reports and
// the public invoice page compute it). No new formula.
export const invoiceTotal = (invoice) => getInvoiceProductPriceTotal(invoice);

export const DUPLICATE_WEIGHTS = {
  sameInvoiceNo: 0.5,
  sameSourceOrder: 0.45,
  sameSourceQuotation: 0.45,
  sameTransactionRef: 0.4,
  samePhone: 0.1,
  sameProducts: 0.15,
  sameTotal: 0.1,
  withinWindow: 0.15,
};
const STRONG = [
  "sameInvoiceNo",
  "sameSourceOrder",
  "sameSourceQuotation",
  "sameTransactionRef",
];
const sameId = (a, b) => Boolean(a && b && String(a) === String(b));
const sameText = (a, b) => {
  const left = String(a ?? "").trim();
  return Boolean(left) && left === String(b ?? "").trim();
};

// Compares two invoices. `transactionMatch` is true when both link (via
// sourceOrderId) to AquaOrder records with the same non-empty transactionId.
// Returns null when the pair is not comparable or nothing points to a
// duplicate. Flagged only on a strong shared reference, or on the full
// combination phone + identical lines + identical total + invoice dates
// within the window; the same customer and amount alone is a repeat
// purchase, not a duplicate. Migrated (bulk-imported) invoices are compared
// only with other migrated invoices and only on the invoice number.
export const compareInvoices = (
  a,
  b,
  { windowDays = 1, transactionMatch = false } = {},
) => {
  if (String(a._id) === String(b._id)) return null;
  if (documentKind(a) !== documentKind(b)) return null;
  if (Boolean(a.migrated) !== Boolean(b.migrated)) return null;
  const dateA = parseInvoicePurchaseDate({ date: a.date });
  const dateB = parseInvoicePurchaseDate({ date: b.date });
  const daysApart =
    dateA && dateB
      ? Math.round((Math.abs(dateA - dateB) / DAY_MS) * 100) / 100
      : null;
  const phoneA = normalizeIndianPhone(
    a.customerPhoneNormalized || a.customerDetails?.phone,
  );
  const phoneB = normalizeIndianPhone(
    b.customerPhoneNormalized || b.customerDetails?.phone,
  );
  const totalA = invoiceTotal(a);
  const totalB = invoiceTotal(b);
  const signatureA = productSignature(a);
  const signals = {
    sameInvoiceNo: sameText(a.invoiceNo, b.invoiceNo),
    sameSourceOrder: sameId(a.sourceOrderId, b.sourceOrderId),
    sameSourceQuotation: sameId(a.sourceQuotationId, b.sourceQuotationId),
    sameTransactionRef: Boolean(transactionMatch),
    samePhone: Boolean(phoneA && phoneA === phoneB),
    sameProducts: Boolean(signatureA) && signatureA === productSignature(b),
    sameTotal: totalA > 0 && totalA === totalB,
    withinWindow: daysApart !== null && daysApart <= windowDays,
  };
  if (a.migrated) {
    for (const key of Object.keys(signals))
      if (key !== "sameInvoiceNo") signals[key] = false;
  }
  const strong = STRONG.some((key) => signals[key]);
  const combination =
    signals.samePhone &&
    signals.sameProducts &&
    signals.sameTotal &&
    signals.withinWindow;
  if (!strong && !combination) return null;
  const basis = Object.keys(signals).filter((key) => signals[key]);
  const score = basis.reduce((sum, key) => sum + DUPLICATE_WEIGHTS[key], 0);
  return {
    signals,
    basis,
    confidence: Math.min(0.99, Math.round(score * 100) / 100),
    daysApart,
    datesKnown: daysApart !== null,
    windowDays,
  };
};

// Earlier invoice (by invoice date, then creation time, then id) is primary.
export const orderPair = (a, b) => {
  const key = (doc) => [
    parseInvoicePurchaseDate({ date: doc.date })?.getTime() ?? Infinity,
    doc.createdAt ? new Date(doc.createdAt).getTime() : Infinity,
    String(doc._id),
  ];
  const [ka, kb] = [key(a), key(b)];
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return [a, b];
    if (ka[i] > kb[i]) return [b, a];
  }
  return [a, b];
};

// ---- Identity and privacy helpers -------------------------------------

export const issueKeyOf = (type, invoiceIds, field = "") =>
  createHash("sha256")
    .update(`${type}|${[...invoiceIds].map(String).sort().join(",")}|${field}`)
    .digest("hex");

export const customerKeyOf = (phone) => {
  const normalized = normalizeIndianPhone(phone);
  return normalized
    ? createHash("sha256")
        .update(`aquakart-customer:${normalized}`)
        .digest("hex")
    : null;
};

export const maskPhone = (phone) => {
  const normalized = normalizeIndianPhone(phone);
  return normalized
    ? `${normalized.slice(0, 2)}******${normalized.slice(-2)}`
    : null;
};

export const revisionOf = (doc) => {
  const stamp = doc?.updatedAt || doc?.createdAt;
  return stamp ? new Date(stamp).toISOString() : "0";
};

export const invoiceDateOf = (invoice) =>
  parseInvoicePurchaseDate({ date: invoice?.date });
