import mongoose from "mongoose";
import AquaProduct from "../../models/product.js";
import AquaStock from "../../models/crm/stock.js";
import AquaInvoice from "../../models/crm/invoice.js";
import {
  persistInvoice,
  validateInvoicePayload,
} from "../../controllers/crm/invoice.js";
import { emailInvoiceToCustomer } from "../../controllers/crm/invoiceDelivery.js";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";
import { buildInvoiceViewLinks } from "../../utils/invoiceViews.js";
import { writeAudit } from "../audit.js";
import {
  MAX_ITEMS,
  applyDraftPatch,
  buildItem,
  describeDraft,
  draftTotals,
  toInvoicePayload,
  updateItem,
  validateDraft,
} from "./draft.js";

// The AI's only window into the database. Every tool returns a small,
// whitelisted set of fields: product search (max 5 results) and a customer
// lookup by exact phone number. Nothing else is readable.

const MAX_SEARCH_RESULTS = 5;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sellingPrice = (product) =>
  product.discountPriceStatus && Number(product.discountPrice) > 0
    ? Number(product.discountPrice)
    : Number(product.price || 0);

export const loadStock = async (items = []) => {
  const ids = [
    ...new Set(items.map((item) => item.productId).filter(Boolean)),
  ].filter((id) => mongoose.isValidObjectId(id));
  const stock = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return stock;
  const records = await AquaStock.find({ productId: { $in: ids } })
    .select("productId quantity")
    .lean();
  for (const record of records) {
    stock.set(String(record.productId), Number(record.quantity || 0));
  }
  return stock;
};

export const validateWithStock = async (draft) =>
  validateDraft(draft, { stock: await loadStock(draft.items) });

const setDraft = (session, draft) => {
  session.draft = draft;
  session.draftVersion += 1;
};

const draftResult = async (session, extra = {}) => ({
  ...extra,
  draftVersion: session.draftVersion,
  draft: describeDraft(session.draft, await validateWithStock(session.draft)),
});

const itemIndex = (session, itemNumber) => {
  const index = Number(itemNumber) - 1;
  return Number.isInteger(index) &&
    index >= 0 &&
    index < session.draft.items.length
    ? index
    : -1;
};

export const searchCatalog = async (query, limit = MAX_SEARCH_RESULTS) => {
  const words = String(query || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (!words.length) return [];

  const fields = ["title", "ShortName", "brand", "code", "sku"];
  const products = await AquaProduct.find({
    $and: words.map((word) => {
      const regex = new RegExp(escapeRegex(word.slice(0, 40)), "i");
      return { $or: fields.map((field) => ({ [field]: regex })) };
    }),
  })
    .select(
      "title brand price discountPrice discountPriceStatus slug seoSlug ShortName code",
    )
    .limit(Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(limit) || 5)))
    .lean();

  const stock = await loadStock(
    products.map((product) => ({ productId: String(product._id) })),
  );
  return products.map((product) => {
    const id = String(product._id);
    const price = sellingPrice(product);
    return {
      productId: id,
      name: product.title,
      brand: product.brand || "",
      sellingPrice: price,
      ...(price !== Number(product.price)
        ? { mrp: Number(product.price) }
        : {}),
      crmStock: stock.get(id),
      slug:
        product.slug ||
        product.seoSlug ||
        product.ShortName ||
        product.code ||
        "",
    };
  });
};

export const createInvoiceFromSession = async (
  session,
  { sendEmail = false, req } = {},
) => {
  if (session.invoice?.id) {
    return { created: false, alreadyCreated: true, invoice: session.invoice };
  }

  const validation = await validateWithStock(session.draft);
  if (!validation.ready) return { created: false, validation };

  const payload = toInvoicePayload(session.draft);
  const { isValid, errors } = validateInvoicePayload(payload);
  if (!isValid) {
    return {
      created: false,
      validation: {
        ready: false,
        errors: Object.entries(errors).map(([field, message]) => ({
          field,
          message,
        })),
        warnings: [],
      },
    };
  }

  let persisted;
  try {
    persisted = await persistInvoice(payload);
  } catch (error) {
    if (!error?.statusCode) throw error;
    return {
      created: false,
      error: error.message,
      details: error.errors,
    };
  }

  const { invoice, whatsappDelivery } = persisted;
  const links = buildInvoiceViewLinks(invoice._id, invoice);
  let emailDelivery = null;
  if (sendEmail) {
    emailDelivery = invoice.customerDetails?.email
      ? (await emailInvoiceToCustomer(invoice)).body
      : { success: false, message: "Customer has no email address" };
  }

  session.invoice = {
    id: String(invoice._id),
    invoiceNo: invoice.invoiceNo,
    total: draftTotals(session.draft).total,
    customerUrl: links.customerUrl,
    adminUrl: links.adminUrl,
    whatsappDelivery,
    emailDelivery,
    createdAt: new Date(),
  };
  session.status = "created";

  await writeAudit({
    req,
    action: "invoice.create",
    resourceType: "Invoice",
    resourceId: invoice._id,
    after: { invoiceNo: invoice.invoiceNo, total: session.invoice.total },
    metadata: {
      source: "ai-invoice-assistant",
      sessionId: String(session._id),
    },
  });

  return { created: true, invoice: session.invoice };
};

export const emailSessionInvoice = async (session) => {
  if (!session.invoice?.id) {
    return { success: false, message: "The invoice has not been created yet" };
  }
  const invoice = await AquaInvoice.findById(session.invoice.id).lean();
  if (!invoice) return { success: false, message: "Invoice not found" };
  const { body } = await emailInvoiceToCustomer(invoice);
  session.invoice = { ...session.invoice, emailDelivery: body };
  return body;
};

const STRING = { type: "string" };
const INTEGER = { type: "integer" };
const NUMBER = { type: "number" };

export const TOOL_DECLARATIONS = [
  {
    name: "search_products",
    description:
      "Search the AquaKart product catalog by name, brand, model code or SKU. Returns at most 5 products with their selling price (GST-inclusive INR) and CRM stock. Always search before adding a catalog product.",
    parameters: {
      type: "object",
      properties: {
        query: {
          ...STRING,
          description: "Words from the product name, brand or code",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_customer",
    description:
      "Look up a returning customer by their exact 10-digit Indian mobile number. Returns name, email and address from their latest invoice, if any. Does not change the draft.",
    parameters: {
      type: "object",
      properties: { phone: STRING },
      required: ["phone"],
    },
  },
  {
    name: "update_invoice_draft",
    description:
      "Set customer, GST and payment fields on the invoice draft. Only pass fields the user actually provided or confirmed. Returns the draft with validation errors (must fix) and warnings (suggestions).",
    parameters: {
      type: "object",
      properties: {
        customerName: STRING,
        customerPhone: STRING,
        customerEmail: STRING,
        customerAddress: STRING,
        gst: { type: "boolean", description: "true for a GST (B2B) invoice" },
        gstName: { ...STRING, description: "Registered business name" },
        gstNo: { ...STRING, description: "15-character GSTIN" },
        gstPhone: STRING,
        gstEmail: STRING,
        gstAddress: STRING,
        paidStatus: {
          ...STRING,
          description: "e.g. Paid, Pending, Partially Paid",
        },
        paymentType: {
          ...STRING,
          description: "e.g. Cash, UPI, Card, Bank Transfer, Cheque",
        },
      },
    },
  },
  {
    name: "add_catalog_item",
    description:
      "Add a product from search_products results. unitPrice defaults to the catalog selling price; only override it when the user states a different price.",
    parameters: {
      type: "object",
      properties: {
        productId: STRING,
        quantity: INTEGER,
        unitPrice: {
          ...NUMBER,
          description: "GST-inclusive price per unit in INR",
        },
        serialNo: STRING,
      },
      required: ["productId", "quantity"],
    },
  },
  {
    name: "add_custom_item",
    description:
      "Add an item that is not in the catalog (e.g. installation charge, plumbing material). Requires a price from the user.",
    parameters: {
      type: "object",
      properties: {
        name: STRING,
        quantity: INTEGER,
        unitPrice: {
          ...NUMBER,
          description: "GST-inclusive price per unit in INR",
        },
        serialNo: STRING,
      },
      required: ["name", "quantity", "unitPrice"],
    },
  },
  {
    name: "update_item",
    description:
      "Change the quantity, unit price or serial number of a draft item.",
    parameters: {
      type: "object",
      properties: {
        itemNumber: {
          ...INTEGER,
          description: "1-based item number from the draft",
        },
        quantity: INTEGER,
        unitPrice: NUMBER,
        serialNo: STRING,
      },
      required: ["itemNumber"],
    },
  },
  {
    name: "remove_item",
    description: "Remove an item from the draft.",
    parameters: {
      type: "object",
      properties: { itemNumber: INTEGER },
      required: ["itemNumber"],
    },
  },
  {
    name: "review_invoice_draft",
    description:
      "Final check before creating. Validates everything including stock. If ready, show the user the full summary and ask them to confirm explicitly. Must be called before create_and_send_invoice.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_and_send_invoice",
    description:
      "Create the invoice and send it to the customer on WhatsApp (and optionally email). Only call this after review_invoice_draft AND after the user explicitly confirmed in a new message (e.g. 'yes, create it').",
    parameters: {
      type: "object",
      properties: {
        sendEmail: {
          type: "boolean",
          description: "Also email the invoice (requires a customer email)",
        },
      },
    },
  },
  {
    name: "send_invoice_email",
    description: "Email the already-created invoice to the customer.",
    parameters: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  search_products: async ({ query }, { session }) => {
    const products = await searchCatalog(query);
    if (!products.length) {
      return { products: [], message: `No products match "${query}"` };
    }
    const known = { ...session.knownProducts };
    for (const product of products) known[product.productId] = product;
    session.knownProducts = known;
    return {
      products: products.map(({ slug: _slug, ...product }) => product),
    };
  },

  lookup_customer: async ({ phone }) => {
    const normalized = normalizeIndianPhone(phone);
    if (!normalized) {
      return {
        found: false,
        error: `"${phone}" is not a valid Indian mobile number`,
      };
    }
    const [latest, previousInvoiceCount] = await Promise.all([
      AquaInvoice.findOne({ customerPhoneNormalized: normalized })
        .sort({ createdAt: -1 })
        .select(
          "customerDetails gst gstDetails.gstName gstDetails.gstNo createdAt",
        )
        .lean(),
      AquaInvoice.countDocuments({ customerPhoneNormalized: normalized }),
    ]);
    if (!latest) return { found: false, phone: normalized };
    return {
      found: true,
      phone: normalized,
      name: latest.customerDetails?.name || "",
      email: latest.customerDetails?.email || "",
      address: latest.customerDetails?.address || "",
      previousInvoiceCount,
      lastInvoiceDate: latest.createdAt,
      ...(latest.gst
        ? {
            lastGst: {
              gstName: latest.gstDetails?.gstName || "",
              gstNo: latest.gstDetails?.gstNo || "",
            },
          }
        : {}),
    };
  },

  update_invoice_draft: async (args, { session }) => {
    const { draft, changed } = applyDraftPatch(session.draft, args);
    if (!changed.length) return { error: "No valid fields were provided" };
    setDraft(session, draft);
    return draftResult(session, { updated: changed });
  },

  add_catalog_item: async (args, { session }) => {
    const product = session.knownProducts?.[args.productId];
    if (!product) {
      return {
        error:
          "Unknown productId. Use search_products and pick a productId from its results.",
      };
    }
    if (session.draft.items.length >= MAX_ITEMS) {
      return { error: `An invoice can have at most ${MAX_ITEMS} items` };
    }
    const item = buildItem({
      product,
      quantity: args.quantity,
      unitPrice: args.unitPrice,
      serialNo: args.serialNo,
    });
    setDraft(session, {
      ...session.draft,
      items: [...session.draft.items, item],
    });
    return draftResult(session, { added: item.productName });
  },

  add_custom_item: async (args, { session }) => {
    if (!String(args.name || "").trim())
      return { error: "Item name is required" };
    if (args.unitPrice === undefined)
      return { error: "Ask the user for the price" };
    if (session.draft.items.length >= MAX_ITEMS) {
      return { error: `An invoice can have at most ${MAX_ITEMS} items` };
    }
    const item = buildItem(args);
    setDraft(session, {
      ...session.draft,
      items: [...session.draft.items, item],
    });
    return draftResult(session, { added: item.productName });
  },

  update_item: async (args, { session }) => {
    const index = itemIndex(session, args.itemNumber);
    if (index < 0) return { error: `There is no item ${args.itemNumber}` };
    const items = [...session.draft.items];
    items[index] = updateItem(items[index], args);
    setDraft(session, { ...session.draft, items });
    return draftResult(session, { updatedItem: index + 1 });
  },

  remove_item: async (args, { session }) => {
    const index = itemIndex(session, args.itemNumber);
    if (index < 0) return { error: `There is no item ${args.itemNumber}` };
    const items = session.draft.items.filter((_item, i) => i !== index);
    setDraft(session, { ...session.draft, items });
    return draftResult(session, { removedItem: index + 1 });
  },

  review_invoice_draft: async (_args, { session, turn }) => {
    if (session.invoice?.id) {
      return {
        error: "This invoice was already created",
        invoice: session.invoice,
      };
    }
    const validation = await validateWithStock(session.draft);
    if (validation.ready) {
      session.review = { version: session.draftVersion, turn };
    }
    return {
      ready: validation.ready,
      draft: describeDraft(session.draft, validation),
      instruction: validation.ready
        ? "Show the user this summary (customer, items with quantity and price, total, warnings) and ask them to confirm. Do not create the invoice in this turn."
        : "Tell the user what must be fixed and ask for the missing or invalid details.",
    };
  },

  create_and_send_invoice: async ({ sendEmail }, { session, turn, req }) => {
    if (session.invoice?.id) {
      return {
        error: "This invoice was already created",
        invoice: session.invoice,
      };
    }
    const reviewed =
      session.review?.version === session.draftVersion &&
      session.review?.turn < turn;
    if (!reviewed) {
      return {
        error:
          "Not confirmed yet. Call review_invoice_draft, show the summary, and wait for the user to confirm in their next message.",
      };
    }
    return createInvoiceFromSession(session, {
      sendEmail: sendEmail === true,
      req,
    });
  },

  send_invoice_email: async (_args, { session }) =>
    emailSessionInvoice(session),
};

export const runTool = async (name, args, context) => {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool "${name}"` };
  try {
    return await handler(args || {}, context);
  } catch (error) {
    console.error(`AI invoice tool ${name} failed:`, error);
    return {
      error: "The tool failed unexpectedly. Try again or ask the user.",
    };
  }
};
