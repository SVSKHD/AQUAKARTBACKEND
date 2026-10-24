import {
  normalizeEmail,
  normalizeIndianPhone,
} from "../../utils/invoiceAccess.js";

// The invoice the AI assistant is building. Kept separate from AquaInvoice so
// nothing touches stock or customers until a human confirms creation.

export const GST_RATE = 0.18;
export const MAX_ITEMS = 25;
const PRICE_DRIFT_WARNING = 0.25;
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const round2 = (value) => Math.round(value * 100) / 100;
const cleanText = (value, max) =>
  value === undefined || value === null
    ? undefined
    : String(value).trim().slice(0, max);
const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export const productLink = (slug) =>
  slug ? `https://aquakart.co.in/product/${slug}` : "";

export const emptyDraft = () => ({
  customer: { name: "", phone: "", email: "", address: "" },
  gst: false,
  gstDetails: {
    gstName: "",
    gstNo: "",
    gstPhone: "",
    gstEmail: "",
    gstAddress: "",
  },
  items: [],
  paidStatus: "",
  paymentType: "",
});

// Flat field names shared by the AI tool and the CRM draft form.
const FIELDS = {
  customerName: ["customer", "name", 120],
  customerPhone: ["customer", "phone", 20],
  customerEmail: ["customer", "email", 120],
  customerAddress: ["customer", "address", 500],
  gstName: ["gstDetails", "gstName", 200],
  gstNo: ["gstDetails", "gstNo", 20],
  gstPhone: ["gstDetails", "gstPhone", 20],
  gstEmail: ["gstDetails", "gstEmail", 120],
  gstAddress: ["gstDetails", "gstAddress", 500],
  paidStatus: [null, "paidStatus", 40],
  paymentType: [null, "paymentType", 40],
};
export const DRAFT_FIELDS = Object.keys(FIELDS);

export const applyDraftPatch = (draft, patch = {}) => {
  const next = structuredClone(draft);
  const changed = [];
  for (const [key, [group, field, max]] of Object.entries(FIELDS)) {
    let value = cleanText(patch[key], max);
    if (value === undefined) continue;
    if (key === "gstNo") value = value.toUpperCase().replace(/\s/g, "");
    if (key.endsWith("Email")) value = value.toLowerCase();
    if (group) next[group][field] = value;
    else next[field] = value;
    changed.push(key);
  }
  if (typeof patch.gst === "boolean") {
    next.gst = patch.gst;
    changed.push("gst");
  }
  return { draft: next, changed };
};

// `product` is a catalog entry as returned by the product search tool.
export const buildItem = ({
  product = null,
  name,
  quantity,
  unitPrice,
  serialNo,
}) => ({
  productId: product ? String(product.productId) : null,
  productName: cleanText(product?.name ?? name, 200) || "",
  productSlug: product?.slug || "",
  catalogPrice: product ? Number(product.sellingPrice) : null,
  quantity: Number(quantity ?? 1),
  unitPrice: Number(unitPrice ?? product?.sellingPrice),
  serialNo: cleanText(serialNo, 100) || "",
});

export const updateItem = (item, { quantity, unitPrice, serialNo }) => ({
  ...item,
  ...(quantity !== undefined ? { quantity: Number(quantity) } : {}),
  ...(unitPrice !== undefined ? { unitPrice: Number(unitPrice) } : {}),
  ...(serialNo !== undefined
    ? { serialNo: cleanText(serialNo, 100) || "" }
    : {}),
});

// `stock` maps productId -> available CRM quantity (null when no stock record).
// Without it, stock checks are skipped.
export const validateDraft = (draft, { stock } = {}) => {
  const errors = [];
  const warnings = [];
  const add = (list, field, message) => list.push({ field, message });
  const { customer, gstDetails } = draft;

  if (!customer.name) add(errors, "customerName", "Customer name is required");
  if (!customer.phone) {
    add(errors, "customerPhone", "Customer phone is required");
  } else if (!normalizeIndianPhone(customer.phone)) {
    add(
      errors,
      "customerPhone",
      `"${customer.phone}" is not a valid Indian mobile number (10 digits starting with 6-9, optionally prefixed with +91)`,
    );
  }
  if (customer.email && !EMAIL_PATTERN.test(customer.email)) {
    add(
      errors,
      "customerEmail",
      `"${customer.email}" is not a valid email address`,
    );
  }
  if (!customer.email) {
    add(
      warnings,
      "customerEmail",
      "No email: the invoice can only be sent on WhatsApp",
    );
  }
  if (!customer.address) {
    add(
      warnings,
      "customerAddress",
      "No address: add one for delivery, installation and service visits",
    );
  }

  if (draft.gst) {
    if (!gstDetails.gstName) {
      add(errors, "gstName", "Business name is required for a GST invoice");
    }
    if (!gstDetails.gstNo) {
      add(errors, "gstNo", "GSTIN is required for a GST invoice");
    } else if (!GSTIN_PATTERN.test(gstDetails.gstNo)) {
      add(
        errors,
        "gstNo",
        `"${gstDetails.gstNo}" is not a valid GSTIN (15 characters, e.g. 36ABCDE1234F1Z5)`,
      );
    }
    if (gstDetails.gstPhone && !normalizeIndianPhone(gstDetails.gstPhone)) {
      add(
        errors,
        "gstPhone",
        `"${gstDetails.gstPhone}" is not a valid Indian mobile number`,
      );
    }
    if (gstDetails.gstEmail && !EMAIL_PATTERN.test(gstDetails.gstEmail)) {
      add(
        errors,
        "gstEmail",
        `"${gstDetails.gstEmail}" is not a valid email address`,
      );
    }
    if (!gstDetails.gstAddress) {
      add(warnings, "gstAddress", "GST billing address is empty");
    }
  }

  if (!draft.items.length) add(errors, "items", "Add at least one product");
  const requiredStock = new Map();
  const seenProducts = new Set();
  draft.items.forEach((item, index) => {
    const field = `items.${index + 1}`;
    const label = `Item ${index + 1} (${item.productName || "unnamed"})`;
    if (!item.productName) add(errors, field, `${label}: name is required`);
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 1000
    ) {
      add(
        errors,
        field,
        `${label}: quantity must be a whole number from 1 to 1000`,
      );
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      add(errors, field, `${label}: price must be a number of 0 or more`);
    } else if (item.unitPrice === 0) {
      add(warnings, field, `${label}: price is ₹0`);
    } else if (
      item.catalogPrice > 0 &&
      Math.abs(item.unitPrice - item.catalogPrice) / item.catalogPrice >
        PRICE_DRIFT_WARNING
    ) {
      add(
        warnings,
        field,
        `${label}: price ${rupees(item.unitPrice)} differs from the catalog price ${rupees(item.catalogPrice)} by more than ${PRICE_DRIFT_WARNING * 100}%`,
      );
    }

    if (!item.productId) {
      add(
        warnings,
        field,
        `${label}: custom item not linked to the catalog, so stock and service reminders won't track it`,
      );
      return;
    }
    if (seenProducts.has(item.productId)) {
      add(
        warnings,
        field,
        `${label}: product appears more than once; consider merging the quantities`,
      );
    }
    seenProducts.add(item.productId);
    if (Number.isInteger(item.quantity) && item.quantity > 0) {
      requiredStock.set(
        item.productId,
        (requiredStock.get(item.productId) || 0) + item.quantity,
      );
    }
  });

  if (stock) {
    for (const [productId, required] of requiredStock) {
      const name =
        draft.items.find((item) => item.productId === productId)?.productName ||
        productId;
      const available = stock.get(productId);
      if (available === undefined || available === null) {
        add(
          errors,
          "items",
          `${name}: no CRM stock record. Add stock in the CRM, or add it as a custom item`,
        );
      } else if (available < required) {
        add(
          errors,
          "items",
          `${name}: only ${available} in CRM stock, but ${required} needed`,
        );
      } else if (available - required <= 2) {
        add(
          warnings,
          "items",
          `${name}: only ${available - required} left in stock after this invoice`,
        );
      }
    }
  }

  if (!draft.paidStatus) {
    add(warnings, "paidStatus", "Payment status not set (e.g. Paid, Pending)");
  }
  if (!draft.paymentType) {
    add(
      warnings,
      "paymentType",
      "Payment method not set (e.g. Cash, UPI, Card, Bank transfer)",
    );
  }

  return { ready: errors.length === 0, errors, warnings };
};

// Prices are GST-inclusive, matching how CRM invoice reports derive GST.
export const draftTotals = (draft) => {
  const total = round2(
    draft.items.reduce((sum, item) => {
      const line = Number(item.unitPrice) * Number(item.quantity);
      return Number.isFinite(line) ? sum + line : sum;
    }, 0),
  );
  const taxableValue = round2(total / (1 + GST_RATE));
  return {
    itemCount: draft.items.length,
    total,
    taxableValue,
    gstAmount: round2(total - taxableValue),
    pricesIncludeGst: true,
  };
};

export const toInvoicePayload = (draft) => {
  const { customer, gstDetails } = draft;
  return {
    customerDetails: {
      name: customer.name,
      phone: Number(normalizeIndianPhone(customer.phone)),
      email: normalizeEmail(customer.email),
      address: customer.address,
    },
    gst: draft.gst === true,
    po: false,
    quotation: false,
    gstDetails: draft.gst
      ? {
          gstName: gstDetails.gstName,
          gstNo: gstDetails.gstNo,
          ...(gstDetails.gstPhone
            ? { gstPhone: Number(normalizeIndianPhone(gstDetails.gstPhone)) }
            : {}),
          gstEmail: gstDetails.gstEmail,
          gstAddress: gstDetails.gstAddress,
        }
      : {},
    // productPrice is the unit price, as in ecommerce order invoices.
    products: draft.items.map((item) => ({
      productName: item.productName,
      productQuantity: item.quantity,
      productPrice: item.unitPrice,
      productSerialNo: item.serialNo,
      ...(item.productId ? { productId: item.productId } : {}),
      productSlug: item.productSlug,
      productLink: productLink(item.productSlug),
    })),
    paidStatus: draft.paidStatus,
    paymentType: draft.paymentType,
  };
};

// Compact view of the draft for the model and the CRM UI.
export const describeDraft = (draft, validation) => ({
  customer: draft.customer,
  gst: draft.gst,
  ...(draft.gst ? { gstDetails: draft.gstDetails } : {}),
  items: draft.items.map((item, index) => ({
    itemNumber: index + 1,
    productId: item.productId,
    productName: item.productName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    catalogPrice: item.catalogPrice,
    lineTotal: round2(Number(item.unitPrice) * Number(item.quantity)),
    serialNo: item.serialNo,
  })),
  paidStatus: draft.paidStatus,
  paymentType: draft.paymentType,
  totals: draftTotals(draft),
  ...(validation ? { validation } : {}),
});
