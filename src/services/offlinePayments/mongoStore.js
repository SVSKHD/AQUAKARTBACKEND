import mongoose from "mongoose";
import AquaQuotation from "../../models/crm/quotation.js";
import AquaPreInvoice from "../../models/crm/preInvoice.js";
import AquaInvoice from "../../models/crm/invoice.js";
import AquaEcomUser from "../../models/user.js";
import PaymentAttempt from "../../models/paymentAttempt.js";
import PaymentGateway from "../../models/paymentGateway.js";
import { isPhonePeConfigured } from "../gateways/phonepe.js";
import OfflinePaymentLink from "../../models/offlinePaymentLink.js";

// MongoDB implementation of the store used by the offline payment service
// and the pre-invoice service. Every conditional update is a single atomic
// findOneAndUpdate; null means the condition no longer held.

const valid = (id) =>
  mongoose.isValidObjectId(id) && /^[a-f\d]{24}$/i.test(String(id));
const after = { returnDocument: "after", runValidators: true };
const models = { quotation: AquaQuotation, pre_invoice: AquaPreInvoice };
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const USER_FIELDS =
  "firebaseUid phone addresses selectedAddress alternatePhone invoices";

export const mongoOfflinePaymentStore = {
  newId: () => new mongoose.Types.ObjectId(),

  // ---- Source documents --------------------------------------------------
  findSource: (kind, id) =>
    valid(id) ? models[kind].findById(id).lean() : null,
  updateSource: (kind, id, condition, update) =>
    models[kind]
      .findOneAndUpdate({ _id: id, ...condition }, update, after)
      .lean(),
  createPreInvoice: async (doc) =>
    (await AquaPreInvoice.create(doc)).toObject(),
  lastPreInvoiceNo: async (prefix) =>
    (
      await AquaPreInvoice.findOne({
        preInvoiceNo: { $regex: `^${escapeRegex(prefix)}` },
      })
        .sort({ preInvoiceNo: -1 })
        .select("preInvoiceNo")
        .lean()
    )?.preInvoiceNo || null,
  listPreInvoices: async ({ status, search, skip, limit }) => {
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { preInvoiceNo: regex },
        { "customerDetails.name": regex },
        { sourceQuotationNo: regex },
      ];
    }
    const [items, total] = await Promise.all([
      AquaPreInvoice.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaPreInvoice.countDocuments(filter),
    ]);
    return { items, total };
  },

  // ---- Links ---------------------------------------------------------------
  createLink: async (doc) => (await OfflinePaymentLink.create(doc)).toObject(),
  findLinkByHash: (tokenHash) =>
    OfflinePaymentLink.findOne({ tokenHash }).lean(),
  findLinkById: (id) =>
    valid(id) ? OfflinePaymentLink.findById(id).lean() : null,
  findLatestLink: (kind, id) =>
    valid(id)
      ? OfflinePaymentLink.findOne({ "source.kind": kind, "source.id": id })
          .sort({ createdAt: -1 })
          .lean()
      : null,
  updateLink: (id, condition, update) =>
    OfflinePaymentLink.findOneAndUpdate(
      { _id: id, ...condition },
      update,
      after,
    ).lean(),
  revokeActiveLinks: async (kind, id, { at, by, reason }) =>
    (
      await OfflinePaymentLink.updateMany(
        { "source.kind": kind, "source.id": id, status: "active" },
        {
          $set: {
            status: "revoked",
            revokedAt: at,
            revokedBy: by,
            revokeReason: reason,
          },
        },
      )
    ).modifiedCount || 0,

  // ---- Payment attempts ------------------------------------------------------
  createAttempt: async (doc) => (await PaymentAttempt.create(doc)).toObject(),
  findAttempt: (id) => PaymentAttempt.findById(id).lean(),
  findAttemptsForLink: (linkId) =>
    PaymentAttempt.find({ paymentLinkId: linkId })
      .sort({ createdAt: -1, _id: -1 })
      .lean(),
  updateAttempt: (id, condition, update) =>
    PaymentAttempt.findOneAndUpdate(
      { _id: id, ...condition },
      update,
      after,
    ).lean(),
  isGatewayEnabled: async (key) => {
    const config = await PaymentGateway.findOne({ key }).lean();
    if (config) return Boolean(config.enabled);
    return key === "phonepe" && isPhonePeConfigured();
  },

  // ---- Invoices and customers -----------------------------------------------
  findInvoiceById: (id) => (valid(id) ? AquaInvoice.findById(id).lean() : null),
  findInvoiceBySource: (kind, id) =>
    AquaInvoice.findOne(
      kind === "pre_invoice"
        ? { sourcePreInvoiceId: id }
        : { sourceQuotationId: id },
    ).lean(),
  setInvoiceOwner: (invoiceId, firebaseUid) =>
    AquaInvoice.updateOne(
      {
        _id: invoiceId,
        $or: [
          { firebaseUid: { $exists: false } },
          { firebaseUid: null },
          { firebaseUid: "" },
        ],
      },
      { $set: { firebaseUid } },
    ),
  findUserById: (id) => AquaEcomUser.findById(id).select(USER_FIELDS).lean(),
  findUserByPhone: (phone, excludeId) =>
    AquaEcomUser.findOne({ phone: Number(phone), _id: { $ne: excludeId } })
      .select("_id")
      .lean(),
  updateUser: (id, update) => AquaEcomUser.updateOne({ _id: id }, update),
};
