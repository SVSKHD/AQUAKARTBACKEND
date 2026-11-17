import { calculateTotals } from "../quotation/quotationTotals.js";
import {
  normalizeIndianPhone,
  validateEmail,
} from "../../utils/invoiceAccess.js";
import { OfflinePaymentError, money } from "./rules.js";

// Pre-invoices (AquaPreInvoice): create directly, move from a quotation,
// list/get, edit while unpaid, cancel. Totals are always computed here with
// the quotation formula; client-sent totals are ignored. A quotation can
// have one active pre-invoice; moving it revokes the quotation's payment
// link and stops its WhatsApp follow-ups.

const OBJECT_ID = /^[a-f\d]{24}$/i;
const EDITABLE = ["Draft", "Payment Pending"];
const text = (value, max = 300) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
const number = (value) => Number(value);

const invalid = (errors) =>
  new OfflinePaymentError(
    400,
    "VALIDATION_FAILED",
    "Please fix the highlighted fields",
    errors,
  );

const cleanLines = (products, errors) => {
  if (!Array.isArray(products) || !products.length || products.length > 100) {
    errors.products = "Add 1-100 products";
    return [];
  }
  return products.map((line, index) => {
    const path = `products[${index}]`;
    const value = {
      productName: text(line?.productName, 200),
      productDescription: text(line?.productDescription, 1000),
      productSerialNo: text(line?.productSerialNo, 100),
      productQuantity: number(line?.productQuantity),
      productPrice: number(line?.productPrice),
      productDiscount: number(line?.productDiscount ?? 0),
      productTax: number(line?.productTax ?? 0),
    };
    if (
      line?.productId !== undefined &&
      line?.productId !== null &&
      line?.productId !== ""
    ) {
      if (OBJECT_ID.test(String(line.productId)))
        value.productId = String(line.productId);
      else errors[`${path}.productId`] = "Invalid product id";
    }
    if (!value.productName)
      errors[`${path}.productName`] = "Product name is required";
    if (!(value.productQuantity > 0))
      errors[`${path}.productQuantity`] = "Quantity must be greater than 0";
    for (const key of ["productPrice", "productDiscount", "productTax"])
      if (!Number.isFinite(value[key]) || value[key] < 0)
        errors[`${path}.${key}`] = "Must be 0 or more";
    return value;
  });
};

const cleanCustomer = (input = {}, errors) => {
  const phone = normalizeIndianPhone(input.phone);
  const value = {
    name: text(input.name, 120),
    phone: phone ? Number(phone) : undefined,
    email: input.email ? validateEmail(input.email) : "",
    address: text(input.address, 500),
  };
  if (!value.name) errors["customerDetails.name"] = "Customer name is required";
  if (!phone)
    errors["customerDetails.phone"] =
      "Enter a valid 10-digit Indian mobile number";
  if (input.email && !value.email)
    errors["customerDetails.email"] = "Invalid email";
  return value;
};

const cleanGst = (body, errors) => {
  const gst = body.gst === true;
  const details = body.gstDetails || {};
  const gstDetails = gst
    ? {
        gstName: text(details.gstName, 200),
        gstNo: text(details.gstNo, 20).toUpperCase(),
        gstPhone: normalizeIndianPhone(details.gstPhone)
          ? Number(normalizeIndianPhone(details.gstPhone))
          : undefined,
        gstEmail: details.gstEmail ? validateEmail(details.gstEmail) : "",
        gstAddress: text(details.gstAddress, 500),
      }
    : {};
  if (gst && !gstDetails.gstNo)
    errors["gstDetails.gstNo"] = "GST number is required when gst is true";
  if (gst && !gstDetails.gstName)
    errors["gstDetails.gstName"] = "GST name is required when gst is true";
  return { gst, gstDetails };
};

const totalsFor = (products, discount, tax) => {
  const totals = calculateTotals({ products, discount, tax });
  return {
    products: totals.products.map((line) => ({
      ...line,
      productTotal: money(line.productTotal),
    })),
    subTotal: money(totals.subTotal),
    discount: money(totals.discount),
    tax: money(totals.tax),
    totalAmount: money(totals.totalAmount),
  };
};

const amount = (value, field, errors) => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0)
    errors[field] = "Must be 0 or more";
  return parsed;
};

export const createPreInvoiceService = ({
  store,
  payments,
  audit = async () => {},
  now = () => new Date(),
}) => {
  const today = () => now().toISOString().split("T")[0];
  const nextNumber = async () => {
    const date = now();
    const key = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const prefix = `AQPI|${key}|`;
    const last = await store.lastPreInvoiceNo(prefix);
    const serial = Number(String(last || "").split("|")[2]) || 0;
    return `${prefix}${String(serial + 1).padStart(4, "0")}`;
  };
  // Number collisions (two creates in the same instant) retry with the next.
  const insert = async (doc) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await store.createPreInvoice({
          ...doc,
          preInvoiceNo: await nextNumber(),
        });
      } catch (error) {
        const numberClash =
          error?.code === 11000 &&
          (error.keyPattern?.preInvoiceNo ||
            /preInvoiceNo/.test(String(error.message || "")));
        if (!numberClash) throw error;
      }
    }
    throw new OfflinePaymentError(
      503,
      "NUMBER_CONFLICT",
      "Could not allocate a pre-invoice number; retry",
    );
  };
  const load = async (preInvoiceId) => {
    const doc = OBJECT_ID.test(String(preInvoiceId))
      ? await store.findSource("pre_invoice", preInvoiceId)
      : null;
    if (!doc)
      throw new OfflinePaymentError(
        404,
        "PRE_INVOICE_NOT_FOUND",
        "Pre-invoice not found",
      );
    return doc;
  };
  const withLink = async (doc) => ({
    preInvoice: doc,
    paymentLink: (
      await payments.getLinkState({ kind: "pre_invoice", sourceId: doc._id })
    ).link,
  });

  return {
    async create(body = {}, actor) {
      const errors = {};
      const customerDetails = cleanCustomer(body.customerDetails, errors);
      const products = cleanLines(body.products, errors);
      const { gst, gstDetails } = cleanGst(body, errors);
      const discount = amount(body.discount, "discount", errors);
      const tax = amount(body.tax, "tax", errors);
      if (body.currency && String(body.currency).toUpperCase() !== "INR")
        errors.currency = "Only INR is supported";
      if (Object.keys(errors).length) throw invalid(errors);
      const doc = await insert({
        date: text(body.date, 20) || today(),
        customerDetails,
        customerPhoneNormalized: String(customerDetails.phone),
        gst,
        gstDetails,
        ...totalsFor(products, discount, tax),
        currency: "INR",
        status: "Draft",
        payment: { status: "Unpaid", amountPaid: 0 },
        createdBy: actor?._id || null,
      });
      await audit({
        action: "pre_invoice.create",
        adminUserId: actor?._id,
        resourceType: "pre_invoice",
        resourceId: doc._id,
        metadata: {
          preInvoiceNo: doc.preInvoiceNo,
          totalAmount: doc.totalAmount,
        },
      });
      return withLink(doc);
    },

    async moveFromQuotation(quotationId, actor) {
      const quotation = OBJECT_ID.test(String(quotationId))
        ? await store.findSource("quotation", quotationId)
        : null;
      if (!quotation)
        throw new OfflinePaymentError(
          404,
          "QUOTATION_NOT_FOUND",
          "Quotation not found",
        );
      if (quotation.convertedToPreInvoice)
        throw new OfflinePaymentError(
          409,
          "QUOTATION_ALREADY_MOVED",
          "This quotation already has a pre-invoice",
          {
            preInvoiceId: String(quotation.convertedToPreInvoice),
          },
        );
      if (quotation.convertedToInvoice)
        throw new OfflinePaymentError(
          409,
          "QUOTATION_ALREADY_INVOICED",
          "This quotation already has an invoice",
        );
      if (
        ["Rejected", "Expired", "Sold", "Paid"].includes(quotation.status) ||
        quotation.payment?.status === "Paid"
      )
        throw new OfflinePaymentError(
          409,
          "QUOTATION_NOT_MOVABLE",
          `A ${quotation.status} quotation can't be moved`,
        );
      const errors = {};
      const customerDetails = cleanCustomer(quotation.customerDetails, errors);
      const products = cleanLines(quotation.products, errors);
      if (Object.keys(errors).length) throw invalid(errors);

      const preInvoiceId = store.newId();
      const claimed = await store.updateSource(
        "quotation",
        quotation._id,
        { convertedToPreInvoice: null, convertedToInvoice: null },
        {
          $set: {
            convertedToPreInvoice: preInvoiceId,
            status: "Converted",
            "whatsapp.followUpEnabled": false,
            "whatsapp.nextFollowUpAt": null,
            "whatsapp.stoppedAt": now(),
          },
        },
      );
      if (!claimed)
        throw new OfflinePaymentError(
          409,
          "QUOTATION_ALREADY_MOVED",
          "This quotation already has a pre-invoice",
        );
      let doc;
      try {
        doc = await insert({
          _id: preInvoiceId,
          date: today(),
          customerDetails,
          customerPhoneNormalized: String(customerDetails.phone),
          gst: quotation.gst === true,
          gstDetails:
            quotation.gst === true ? { ...(quotation.gstDetails || {}) } : {},
          ...totalsFor(
            products,
            Number(quotation.discount) || 0,
            Number(quotation.tax) || 0,
          ),
          currency: String(quotation.currency || "INR").toUpperCase(),
          status: "Draft",
          payment: { status: "Unpaid", amountPaid: 0 },
          sourceQuotationId: quotation._id,
          sourceQuotationNo: quotation.quotationNo || "",
          sourceQuotationStatus: quotation.status,
          createdBy: actor?._id || null,
        });
      } catch (error) {
        await store.updateSource(
          "quotation",
          quotation._id,
          { convertedToPreInvoice: preInvoiceId },
          { $set: { convertedToPreInvoice: null, status: quotation.status } },
        );
        throw error;
      }
      const revoked = await payments.revokeActive(
        "quotation",
        quotation._id,
        actor,
        "moved_to_pre_invoice",
      );
      await audit({
        action: "pre_invoice.move_from_quotation",
        adminUserId: actor?._id,
        resourceType: "pre_invoice",
        resourceId: doc._id,
        metadata: {
          preInvoiceNo: doc.preInvoiceNo,
          quotationId: String(quotation._id),
          quotationNo: quotation.quotationNo,
          quotationLinksRevoked: revoked,
        },
      });
      return { ...(await withLink(doc)), quotationLinksRevoked: revoked };
    },

    async list(query = {}) {
      const page = Math.max(Number(query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
      const { items, total } = await store.listPreInvoices({
        status: query.status ? text(query.status, 30) : undefined,
        search: query.search ? text(query.search, 80) : undefined,
        skip: (page - 1) * limit,
        limit,
      });
      return {
        data: items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    },

    get: async (preInvoiceId) => withLink(await load(preInvoiceId)),

    async update(preInvoiceId, body = {}, actor) {
      const doc = await load(preInvoiceId);
      if (!EDITABLE.includes(doc.status) || doc.payment?.status === "Paid")
        throw new OfflinePaymentError(
          409,
          "PRE_INVOICE_LOCKED",
          `A ${doc.status} pre-invoice can't be edited`,
        );
      const errors = {};
      const set = {};
      if (body.customerDetails !== undefined) {
        set.customerDetails = cleanCustomer(
          { ...doc.customerDetails, ...body.customerDetails },
          errors,
        );
        set.customerPhoneNormalized = String(set.customerDetails.phone || "");
      }
      if (body.gst !== undefined || body.gstDetails !== undefined)
        Object.assign(
          set,
          cleanGst(
            {
              gst: body.gst ?? doc.gst,
              gstDetails: { ...doc.gstDetails, ...body.gstDetails },
            },
            errors,
          ),
        );
      if (body.date !== undefined) set.date = text(body.date, 20);
      if (
        body.products !== undefined ||
        body.discount !== undefined ||
        body.tax !== undefined
      ) {
        const products =
          body.products !== undefined
            ? cleanLines(body.products, errors)
            : doc.products;
        const discount =
          body.discount !== undefined
            ? amount(body.discount, "discount", errors)
            : doc.discount;
        const tax =
          body.tax !== undefined ? amount(body.tax, "tax", errors) : doc.tax;
        Object.assign(set, totalsFor(products, discount, tax));
      }
      if (body.status !== undefined) {
        if (!["Draft", "Payment Pending", "Cancelled"].includes(body.status))
          errors.status = "Status can be Draft, Payment Pending or Cancelled";
        else set.status = body.status;
      }
      if (Object.keys(errors).length) throw invalid(errors);
      if (!Object.keys(set).length)
        throw new OfflinePaymentError(
          400,
          "NOTHING_TO_UPDATE",
          "No editable fields were sent",
        );
      set.updatedBy = actor?._id || null;
      const updated = await store.updateSource(
        "pre_invoice",
        doc._id,
        { status: { $in: EDITABLE }, "payment.status": { $ne: "Paid" } },
        { $set: set },
      );
      if (!updated)
        throw new OfflinePaymentError(
          409,
          "PRE_INVOICE_LOCKED",
          "The pre-invoice changed (for example it was paid); reload it",
        );
      let revoked = 0;
      if (set.status === "Cancelled") {
        revoked = await payments.revokeActive(
          "pre_invoice",
          doc._id,
          actor,
          "pre_invoice_cancelled",
        );
        if (doc.sourceQuotationId)
          await store.updateSource(
            "quotation",
            doc.sourceQuotationId,
            { convertedToPreInvoice: doc._id },
            {
              $set: {
                convertedToPreInvoice: null,
                status: doc.sourceQuotationStatus || "Accepted",
              },
            },
          );
      }
      await audit({
        action:
          set.status === "Cancelled"
            ? "pre_invoice.cancel"
            : "pre_invoice.update",
        adminUserId: actor?._id,
        resourceType: "pre_invoice",
        resourceId: doc._id,
        metadata: { fields: Object.keys(set), linksRevoked: revoked },
      });
      return withLink(updated);
    },
  };
};
