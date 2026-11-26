import mongoose from "mongoose";
import AquaTransit from "../../models/transit/transit.js";
import TransitWarehouse from "../../models/transit/warehouse.js";
import TransitRateCard from "../../models/transit/rateCard.js";
import TransportBenchmark from "../../models/transit/benchmark.js";
import TransitSettlementBatch from "../../models/transit/settlementBatch.js";
import AquaInvoice from "../../models/crm/invoice.js";
import AquaEcomUser from "../../models/user.js";
import { loadQuickCatalog } from "../../controllers/crm/aiInvoice.js";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";

// MongoDB persistence for the Transit service. Conditional updates return
// null when the condition no longer matches (the service treats that as a
// concurrent change).

const valid = (id) => mongoose.isValidObjectId(id);
const updateOptions = (options = {}) => ({ new: true, ...options });

export const mongoTransitStore = {
  newId: () => new mongoose.Types.ObjectId(),

  // ---- Catalog (same product view as the CRM quick-paste invoice draft) ----
  loadProducts: async (ids = []) => {
    const wanted = new Set(ids.map(String));
    return (await loadQuickCatalog()).filter((product) =>
      wanted.has(product.productId),
    );
  },

  // ---- Warehouse ----
  getActiveWarehouse: () => TransitWarehouse.findOne({ isActive: true }).lean(),
  replaceActiveWarehouse: async (doc, actorId) => {
    await TransitWarehouse.updateMany(
      { isActive: true },
      {
        $set: { isActive: false, updatedBy: actorId },
        $push: {
          history: { at: new Date(), by: actorId, action: "deactivated" },
        },
      },
    );
    return (await TransitWarehouse.create(doc)).toObject();
  },

  // ---- Rate cards ----
  listRateCards: () =>
    TransitRateCard.find({}).sort({ effectiveFrom: -1 }).lean(),
  listActiveRateCards: () => TransitRateCard.find({ status: "active" }).lean(),
  findRateCard: (id) =>
    valid(id) ? TransitRateCard.findById(id).lean() : null,
  createRateCard: async (doc) => (await TransitRateCard.create(doc)).toObject(),
  updateRateCard: (id, update) =>
    TransitRateCard.findByIdAndUpdate(id, update, updateOptions()).lean(),

  // ---- Benchmarks ----
  listBenchmarks: ({ activeOnly = false } = {}) =>
    TransportBenchmark.find(activeOnly ? { isActive: true } : {})
      .sort({ provider: 1, vehicleType: 1 })
      .lean(),
  findBenchmark: (id) =>
    valid(id) ? TransportBenchmark.findById(id).lean() : null,
  createBenchmark: async (doc) =>
    (await TransportBenchmark.create(doc)).toObject(),
  updateBenchmark: (id, update) =>
    TransportBenchmark.findByIdAndUpdate(id, update, updateOptions()).lean(),

  // ---- Transits ----
  findTransit: (id) => (valid(id) ? AquaTransit.findById(id).lean() : null),
  findTransitByKey: (transporterId, idempotencyKey) =>
    AquaTransit.findOne({ transporterId, idempotencyKey }).lean(),
  createTransit: async (doc) => (await AquaTransit.create(doc)).toObject(),
  updateTransit: (id, condition, update, options) =>
    AquaTransit.findOneAndUpdate(
      { _id: id, ...condition },
      update,
      updateOptions({ runValidators: true, ...options }),
    ).lean(),
  listTransits: async ({ filter, skip, limit }) => {
    const [items, total] = await Promise.all([
      AquaTransit.find(filter)
        .select(
          "-delivery.polyline -customerPayment.collections -corrections -history",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaTransit.countDocuments(filter),
    ]);
    return { items, total };
  },
  findTransits: (filter, { limit = 5000 } = {}) =>
    AquaTransit.find(filter)
      .select("-delivery.polyline -corrections -history")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  settleTransits: async (filter, update) =>
    (await AquaTransit.updateMany(filter, update)).modifiedCount,

  // ---- Invoices and customers ----
  findInvoiceById: (id) => (valid(id) ? AquaInvoice.findById(id).lean() : null),
  findInvoiceByTransit: (transitId) =>
    AquaInvoice.findOne({ sourceTransitId: transitId }).lean(),
  setInvoicePayment: (invoiceId, { paidStatus, paymentType }) =>
    AquaInvoice.updateOne(
      { _id: invoiceId },
      { $set: { paidStatus, ...(paymentType ? { paymentType } : {}) } },
    ),
  correctInvoiceDelivery: (invoiceId, { address, transitDelivery }) =>
    AquaInvoice.updateOne(
      { _id: invoiceId },
      { $set: { "customerDetails.address": address, transitDelivery } },
      { transitCorrection: true },
    ),
  // Existing rule (offline payment links): an invoice is linked to the
  // storefront account with the same phone; accounts are never created here.
  linkCustomer: async (invoice) => {
    const phone = normalizeIndianPhone(invoice?.customerDetails?.phone);
    if (!phone) return;
    const user = await AquaEcomUser.findOne({ phone: Number(phone) })
      .select("_id firebaseUid invoices")
      .lean();
    if (!user) return;
    if (user.firebaseUid)
      await AquaInvoice.updateOne(
        {
          _id: invoice._id,
          $or: [
            { firebaseUid: { $exists: false } },
            { firebaseUid: null },
            { firebaseUid: "" },
          ],
        },
        { $set: { firebaseUid: user.firebaseUid } },
      );
    const linked = (user.invoices || []).some(
      (entry) => String(entry.invoiceId) === String(invoice._id),
    );
    if (!linked)
      await AquaEcomUser.updateOne(
        { _id: user._id },
        {
          $push: {
            invoices: {
              invoiceId: invoice._id,
              invoiceNo: invoice.invoiceNo || "",
              linkedAt: new Date(),
            },
          },
        },
      );
  },

  // ---- Settlement batches ----
  findSettlementBatchByKey: (idempotencyKey) =>
    TransitSettlementBatch.findOne({ idempotencyKey }).lean(),
  createSettlementBatch: async (doc) =>
    (await TransitSettlementBatch.create(doc)).toObject(),
  updateSettlementBatch: (id, update) =>
    TransitSettlementBatch.findByIdAndUpdate(
      id,
      update,
      updateOptions(),
    ).lean(),
  listSettlementBatches: async ({ skip, limit }) => {
    const [items, total] = await Promise.all([
      TransitSettlementBatch.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      TransitSettlementBatch.countDocuments({}),
    ]);
    return { items, total };
  },
};
