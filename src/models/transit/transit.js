import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// One delivery made by a transporter, linked to the invoice it created.
// Lifecycle (status): processing -> invoiced | failed; invoiced -> cancelled.
// The delivery route and the price applied are snapshots: they can only
// change through the audited correction flow (see SNAPSHOT_PATHS below).

export const TRANSIT_STATUSES = [
  "processing",
  "invoiced",
  "failed",
  "cancelled",
];
export const SETTLEMENT_STATUSES = ["UNSETTLED", "SETTLED"];
export const CUSTOMER_PAYMENT_STATUSES = ["unpaid", "paid"];
export const COLLECTION_METHODS = ["cash", "upi", "card", "bank_transfer"];
// cash_confirmed: the transporter confirms they hold the cash.
// transporter_reported: the transporter says the customer paid by UPI/card/
//   bank; it does not count as paid until verified.
// admin_verified: an admin checked a reported payment (bank statement etc.).
// provider_verified: confirmed by the payment provider's API.
// rejected: an admin rejected a reported payment.
export const COLLECTION_VERIFICATIONS = [
  "cash_confirmed",
  "transporter_reported",
  "admin_verified",
  "provider_verified",
  "rejected",
];
export const INVOICE_DELIVERY_STATUSES = [
  "pending",
  "sending",
  // The messaging provider accepted the message. Handset delivery is not
  // confirmed by any receipt, so this is never called "delivered".
  "accepted",
  "failed",
];

const point = {
  lat: { type: Number },
  lng: { type: Number },
};

const collectionSchema = new mongoose.Schema({
  collectionKey: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  method: { type: String, enum: COLLECTION_METHODS, required: true },
  verification: {
    type: String,
    enum: COLLECTION_VERIFICATIONS,
    required: true,
  },
  reference: { type: String, default: "" },
  note: { type: String, default: "" },
  collectedBy: { type: ObjectId, ref: "AquaAdminUser", required: true },
  collectedAt: { type: Date, required: true },
  verifiedBy: { type: ObjectId, ref: "AquaAdminUser" },
  verifiedAt: { type: Date },
  verificationNote: { type: String },
});

const correctionSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: ObjectId, ref: "AquaAdminUser", required: true },
    reason: { type: String, required: true },
    before: Mixed,
    after: Mixed,
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: ObjectId, ref: "AquaAdminUser" },
    action: String,
    note: String,
  },
  { _id: false },
);

const TransitSchema = new mongoose.Schema(
  {
    transporterId: {
      type: ObjectId,
      ref: "AquaAdminUser",
      required: true,
      index: true,
    },
    transporterName: { type: String, default: "" },
    idempotencyKey: { type: String, required: true },
    // Hash of the confirmed request, to refuse a reused key with new data.
    requestHash: { type: String, required: true },
    status: {
      type: String,
      enum: TRANSIT_STATUSES,
      default: "processing",
      index: true,
    },
    lockedUntil: { type: Date, default: null },
    lastError: { code: String, message: String, at: Date },

    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true, index: true },
      email: { type: String, default: "" },
    },
    items: [
      {
        _id: false,
        productId: { type: ObjectId, ref: "AquaProduct", required: true },
        productName: { type: String, required: true },
        productSlug: { type: String, default: "" },
        quantity: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true, min: 0 },
        catalogPrice: { type: Number, default: null },
        serialNo: { type: String, default: "" },
      },
    ],
    // Product selling total; independent of the transport expense.
    invoiceTotal: { type: Number, required: true, min: 0 },
    warnings: [{ _id: false, field: String, message: String }],

    // ---- Snapshots (immutable except through corrections) ----
    delivery: {
      address: { type: String, required: true },
      formattedAddress: { type: String, default: "" },
      destination: {
        ...point,
        source: { type: String, enum: ["geocoded", "pinned"] },
        placeId: { type: String, default: "" },
      },
      warehouse: {
        id: { type: ObjectId, ref: "AquaTransitWarehouse" },
        name: String,
        address: String,
        ...point,
      },
      distanceKm: { type: Number, required: true, min: 0 },
      durationMinutes: { type: Number, default: null },
      provider: { type: String, required: true },
      polyline: { type: String, default: "" },
      routedAt: { type: Date, required: true },
    },
    pricing: {
      rateCardId: { type: ObjectId, ref: "AquaTransitRateCard" },
      rateCardName: String,
      tier: { minKm: Number, maxKm: Number, price: Number },
      baseCharge: { type: Number, required: true, min: 0 },
      cashIncentive: { type: Number, required: true, min: 0 },
      currency: { type: String, default: "INR" },
    },
    snapshotHash: { type: String, required: true },

    // ---- Invoice ----
    invoiceId: { type: ObjectId, ref: "AquaInvoice", index: true },
    invoiceNo: { type: String },
    invoiceDelivery: {
      status: {
        type: String,
        enum: INVOICE_DELIVERY_STATUSES,
        default: "pending",
      },
      attempts: { type: Number, default: 0 },
      channel: { type: String },
      lastAttemptAt: { type: Date },
      acceptedAt: { type: Date },
      lastErrorCode: { type: String },
    },

    // ---- Customer payment (independent of the transporter payout) ----
    customerPayment: {
      status: {
        type: String,
        enum: CUSTOMER_PAYMENT_STATUSES,
        default: "unpaid",
        index: true,
      },
      amountDue: { type: Number, required: true, min: 0 },
      // Cash confirmed + verified payments.
      amountConfirmed: { type: Number, default: 0 },
      // Reported UPI/card/bank payments waiting for verification.
      amountPendingVerification: { type: Number, default: 0 },
      paidAt: { type: Date },
      exception: {
        approvedBy: { type: ObjectId, ref: "AquaAdminUser" },
        approvedAt: Date,
        reason: String,
      },
      collections: [collectionSchema],
      // Optimistic-concurrency counter for collection updates.
      revision: { type: Number, default: 0 },
    },

    // ---- Transporter payout ----
    payout: {
      baseCharge: { type: Number, required: true, min: 0 },
      cashIncentive: { type: Number, default: 0, min: 0 },
      incentiveAwarded: { type: Boolean, default: false },
      incentiveCollectionId: { type: ObjectId },
      totalPayable: { type: Number, required: true, min: 0 },
      settlementStatus: {
        type: String,
        enum: SETTLEMENT_STATUSES,
        default: "UNSETTLED",
        index: true,
      },
      settledAt: Date,
      settledBy: { type: ObjectId, ref: "AquaAdminUser" },
      settlementReference: String,
      settlementBatchId: {
        type: ObjectId,
        ref: "AquaTransitSettlementBatch",
        index: true,
      },
    },

    corrections: [correctionSchema],
    cancellation: {
      at: Date,
      by: { type: ObjectId, ref: "AquaAdminUser" },
      reason: String,
    },
    history: [historySchema],
  },
  { timestamps: true },
);

// One transit per transporter request, however often it is retried.
TransitSchema.index({ transporterId: 1, idempotencyKey: 1 }, { unique: true });
TransitSchema.index({ createdAt: -1 });

// ---- Snapshot guard ---------------------------------------------------------

export const SNAPSHOT_PATHS = ["delivery", "pricing", "snapshotHash"];

const touchesSnapshot = (key) =>
  SNAPSHOT_PATHS.some((path) => key === path || key.startsWith(`${path}.`));

/** Throws when an update would change a snapshot outside a correction. */
export const assertSnapshotUntouched = (update = {}, options = {}) => {
  if (options.transitCorrection === true) return;
  const keys = Object.entries(update || {}).flatMap(([key, value]) =>
    key.startsWith("$") && value && typeof value === "object"
      ? Object.keys(value)
      : [key],
  );
  const touched = keys.filter(touchesSnapshot);
  if (touched.length) {
    const error = new Error(
      "Transit delivery and pricing snapshots cannot be edited; record a correction instead",
    );
    error.statusCode = 409;
    error.code = "TRANSIT_SNAPSHOT_IMMUTABLE";
    error.paths = touched;
    throw error;
  }
};

function guardQuery() {
  assertSnapshotUntouched(this.getUpdate(), this.getOptions());
}
TransitSchema.pre("findOneAndUpdate", guardQuery);
TransitSchema.pre("updateOne", guardQuery);
TransitSchema.pre("updateMany", guardQuery);
TransitSchema.pre("save", function guardSave() {
  if (this.isNew || this.$locals?.transitCorrection === true) return;
  const touched = SNAPSHOT_PATHS.filter((path) => this.isModified(path));
  if (touched.length)
    assertSnapshotUntouched(
      Object.fromEntries(touched.map((path) => [path, true])),
    );
});

export default mongoose.models.AquaTransit ||
  mongoose.model("AquaTransit", TransitSchema);
