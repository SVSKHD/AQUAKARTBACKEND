import mongoose from "mongoose";
import AquaInvoice from "../../models/crm/invoice.js";
import AquaOrder from "../../models/orders.js";
import AquaCRMOrder from "../../models/crm/order.js";
import AquaQuotation from "../../models/crm/quotation.js";
import AquaEcomUser from "../../models/user.js";
import InvoiceAction from "../../models/mcp/invoiceAction.js";

// MongoDB access for the MCP invoice audit (invoiceAuditTools.js and
// invoiceActionTools.js). Field allowlists keep payment, GST and access
// metadata out of the audit. The only invoice write is updateInvoiceAddress.

const valid = (id) =>
  mongoose.isValidObjectId(id) && /^[a-f\d]{24}$/i.test(String(id));
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const after = { returnDocument: "after" };

const INVOICE_FIELDS =
  "invoiceNo date customerDetails.name customerDetails.phone customerDetails.address customerPhoneNormalized firebaseUid gst po quotation products.productId products.productName products.productQuantity products.productPrice paidStatus sourceOrderId sourceOrderNo sourceOrderCollection sourceQuotationId sourceQuotationNo migrated createdAt updatedAt";
const ORDER_FIELDS =
  "orderId transactionId shippingAddress billingAddress invoiceId";
const CRM_ORDER_FIELDS =
  "orderNumber customer.address customer.city customer.pincode invoiceId";
const USER_FIELDS = "addresses selectedAddress";

const kindFilter = (kinds = ["invoice"]) => {
  const parts = [];
  if (kinds.includes("invoice"))
    parts.push({ quotation: { $ne: true }, po: { $ne: true } });
  if (kinds.includes("po")) parts.push({ po: true, quotation: { $ne: true } });
  if (kinds.includes("quotation")) parts.push({ quotation: true });
  return parts.length ? { $or: parts } : { _id: null };
};

export const mongoInvoiceStore = {
  // Invoices created in [from, to], oldest first, after the cursor id.
  // Migrated (bulk-imported) records only when includeMigrated.
  scanInvoices: ({ from, to, afterId, limit, kinds, includeMigrated }) => {
    const filter = {
      createdAt: { $gte: from, $lte: to },
      ...kindFilter(kinds),
      ...(includeMigrated ? {} : { migrated: { $ne: true } }),
      ...(afterId && valid(afterId) ? { _id: { $gt: oid(afterId) } } : {}),
    };
    return AquaInvoice.find(filter)
      .select(INVOICE_FIELDS)
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
  },
  findInvoice: (id) =>
    valid(id) ? AquaInvoice.findById(id).select(INVOICE_FIELDS).lean() : null,
  findInvoicesByIds: (ids) =>
    AquaInvoice.find({ _id: { $in: ids.filter(valid).map(oid) } })
      .select(INVOICE_FIELDS)
      .lean(),

  // Invoices sharing a strong reference or the phone number. The rules in
  // invoiceAuditRules.js decide which of these are real candidates.
  findDuplicateCandidates: (invoice, { transactionOrderIds = [] } = {}) => {
    const or = [];
    const invoiceNo = String(invoice.invoiceNo || "").trim();
    if (invoiceNo) or.push({ invoiceNo });
    if (invoice.sourceOrderId)
      or.push({ sourceOrderId: invoice.sourceOrderId });
    if (invoice.sourceQuotationId)
      or.push({ sourceQuotationId: invoice.sourceQuotationId });
    if (invoice.customerPhoneNormalized)
      or.push({ customerPhoneNormalized: invoice.customerPhoneNormalized });
    const orderIds = transactionOrderIds.filter(valid).map(oid);
    if (orderIds.length) or.push({ sourceOrderId: { $in: orderIds } });
    if (!or.length) return [];
    return AquaInvoice.find({ _id: { $ne: invoice._id }, $or: or })
      .select(INVOICE_FIELDS)
      .sort({ _id: 1 })
      .limit(100)
      .lean();
  },

  findOrder: (id) =>
    valid(id) ? AquaOrder.findById(id).select(ORDER_FIELDS).lean() : null,
  findOrdersForInvoice: async (invoiceId) => {
    if (!valid(invoiceId)) return { orders: [], crmOrders: [] };
    const [orders, crmOrders] = await Promise.all([
      AquaOrder.find({ invoiceId }).select(ORDER_FIELDS).limit(5).lean(),
      AquaCRMOrder.find({ invoiceId }).select(CRM_ORDER_FIELDS).limit(5).lean(),
    ]);
    return { orders, crmOrders };
  },
  // Other AquaOrder ids with the same gateway transactionId.
  findOrderIdsByTransaction: async (transactionId, excludeOrderId) =>
    (
      await AquaOrder.find({
        transactionId,
        ...(valid(excludeOrderId) ? { _id: { $ne: oid(excludeOrderId) } } : {}),
      })
        .select("_id")
        .limit(20)
        .lean()
    ).map((order) => order._id),
  findQuotation: (id) =>
    valid(id)
      ? AquaQuotation.findById(id)
          .select("quotationNo customerDetails.address")
          .lean()
      : null,
  findUserByFirebaseUid: (firebaseUid) =>
    AquaEcomUser.findOne({ firebaseUid: String(firebaseUid) })
      .select(USER_FIELDS)
      .lean(),
  findUserByPhone: (phone) =>
    AquaEcomUser.findOne({ phone: Number(phone) })
      .select(USER_FIELDS)
      .lean(),
  findInvoiceAddressesByPhone: (phone, excludeId) =>
    AquaInvoice.find({
      customerPhoneNormalized: String(phone),
      _id: { $ne: excludeId },
      "customerDetails.address": { $nin: [null, ""] },
    })
      .select("invoiceNo customerDetails.address")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),

  // The only invoice write: fills customerDetails.address if the invoice is
  // unchanged since it was read (same updatedAt). The dotted $set leaves the
  // rest of customerDetails, totals and GST untouched. Returns null if the
  // invoice changed in between.
  updateInvoiceAddress: (id, updatedAt, address) =>
    AquaInvoice.findOneAndUpdate(
      { _id: id, updatedAt: updatedAt ?? null },
      { $set: { "customerDetails.address": address } },
      { ...after, projection: INVOICE_FIELDS },
    ).lean(),

  // ---- Suggested actions ------------------------------------------------
  findAction: (actionId) => InvoiceAction.findOne({ actionId }).lean(),
  findActionByIssueKey: (issueKey) =>
    InvoiceAction.findOne({ issueKey }).lean(),
  createAction: async (doc) => (await InvoiceAction.create(doc)).toObject(),
  updateAction: (actionId, update) =>
    InvoiceAction.findOneAndUpdate({ actionId }, update, after).lean(),
  // Atomic state change: only from one of `statuses`, or from an expired
  // `executing` claim. Returns null when another call holds it.
  claimAction: (actionId, statuses, now, update) =>
    InvoiceAction.findOneAndUpdate(
      {
        actionId,
        $or: [
          { status: { $in: statuses } },
          { status: "executing", executingUntil: { $lt: now } },
        ],
      },
      update,
      after,
    ).lean(),
  markOpenActionsStale: async (invoiceId, types, { at, note }) => {
    const result = await InvoiceAction.updateMany(
      {
        invoiceId,
        type: { $in: types },
        status: { $in: ["pending_review", "approved"] },
      },
      {
        $set: { status: "stale" },
        $push: { history: { status: "stale", at, note } },
      },
    );
    return result.modifiedCount || 0;
  },
  listActions: async (filter, { skip, limit, sort }) => {
    const query = {};
    if (filter.type) query.type = filter.type;
    if (filter.status) query.status = filter.status;
    if (filter.statusIn) query.status = { $in: filter.statusIn };
    if (filter.actionId) query.actionId = filter.actionId;
    if (filter.customerKey) query.customerKey = filter.customerKey;
    if (
      filter.minConfidence !== undefined ||
      filter.maxConfidence !== undefined
    )
      query.confidence = {
        ...(filter.minConfidence !== undefined
          ? { $gte: filter.minConfidence }
          : {}),
        ...(filter.maxConfidence !== undefined
          ? { $lte: filter.maxConfidence }
          : {}),
      };
    if (filter.invoiceDateFrom || filter.invoiceDateTo)
      query.invoiceDate = {
        ...(filter.invoiceDateFrom ? { $gte: filter.invoiceDateFrom } : {}),
        ...(filter.invoiceDateTo ? { $lte: filter.invoiceDateTo } : {}),
      };
    if (filter.invoiceId && valid(filter.invoiceId))
      query.$or = [
        { invoiceId: oid(filter.invoiceId) },
        { relatedInvoiceIds: oid(filter.invoiceId) },
      ];
    const [items, total] = await Promise.all([
      InvoiceAction.find(query)
        .sort({ [sort || "createdAt"]: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InvoiceAction.countDocuments(query),
    ]);
    return { items, total };
  },
};
