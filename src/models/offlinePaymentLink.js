import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// A one-time customer payment link for a pre-invoice or a quotation
// (src/services/offlinePayments). Only the SHA-256 of the random token is
// stored; the token itself is shown to the admin once. snapshotHash covers
// the source's lines and totals at creation: if the source changes, the link
// stops working and must be regenerated. One active link per source document
// (partial unique index).

export const OFFLINE_LINK_STATUSES = ["active", "revoked", "expired", "paid"];
export const CONVERSION_STATUSES = [
  "none",
  "in_progress",
  "done",
  "failed",
  "blocked_stock",
  "needs_review",
];

const OfflinePaymentLinkSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    // Encrypted token for "Send" from the CRM (rules.js sealLinkToken). Never
    // returned by any API; empty for links created before it existed.
    tokenSealed: { type: String, default: "" },
    source: {
      kind: {
        type: String,
        enum: ["pre_invoice", "quotation"],
        required: true,
      },
      id: { type: ObjectId, required: true },
      number: { type: String },
    },
    phoneNormalized: { type: String, default: "" },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    snapshotHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: OFFLINE_LINK_STATUSES,
      default: "active",
      index: true,
    },
    createdBy: { type: ObjectId, ref: "AquaAdminUser" },
    revokedAt: Date,
    revokedBy: { type: ObjectId, ref: "AquaAdminUser" },
    revokeReason: String,

    // Customer binding: once set, only this signed-in user may continue.
    userId: { type: ObjectId, ref: "AquaEcomUser", default: null },
    boundAt: Date,
    // Address the customer entered, used on the final invoice only when the
    // source document has no address.
    deliveryAddress: { type: String, default: "" },
    // e.g. PHONE_ON_OTHER_ACCOUNT, PAID_AFTER_REVOKE, DUPLICATE_PAYMENT,
    // AMOUNT_CHANGED_AFTER_PAYMENT: reasons for an admin to look at it.
    reviewFlags: { type: [String], default: [] },

    // Serializes "initiate payment" for this link.
    initiateLockUntil: { type: Date, default: null },

    paidAt: Date,
    paidAttemptId: { type: ObjectId, ref: "AquaPaymentAttempt" },
    gatewayTransactionId: String,
    amountPaid: Number,

    conversion: {
      status: { type: String, enum: CONVERSION_STATUSES, default: "none" },
      lockedUntil: Date,
      attempts: { type: Number, default: 0 },
      invoiceId: { type: ObjectId, ref: "AquaInvoice" },
      invoiceNo: String,
      lastError: String,
      at: Date,
    },
  },
  { timestamps: true },
);

OfflinePaymentLinkSchema.index(
  { "source.kind": 1, "source.id": 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
OfflinePaymentLinkSchema.index({ "source.id": 1, createdAt: -1 });

const OfflinePaymentLink =
  mongoose.models.AquaOfflinePaymentLink ||
  mongoose.model("AquaOfflinePaymentLink", OfflinePaymentLinkSchema);

export default OfflinePaymentLink;
