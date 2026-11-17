import mongoose from "mongoose";

// ECOM: storefront checkout (checkoutSessionId + orderId), unchanged.
// CRM_OFFLINE: an admin-created payment link for a pre-invoice or quotation
// (src/services/offlinePayments): no checkout session, no order.
export const PAYMENT_ATTEMPT_SOURCES = ["ECOM", "CRM_OFFLINE"];

const PaymentAttemptSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: PAYMENT_ATTEMPT_SOURCES,
      default: "ECOM",
      index: true,
    },
    checkoutSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaCheckoutSession",
      // Still required for every storefront (ECOM) attempt.
      required: function requiredForEcom() {
        return (this.source || "ECOM") === "ECOM";
      },
      index: true,
    },
    sourceKind: { type: String, enum: ["pre_invoice", "quotation"] },
    sourceId: { type: mongoose.Schema.Types.ObjectId, index: true },
    paymentLinkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaOfflinePaymentLink",
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaOrder",
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaEcomUser",
      required: true,
      index: true,
    },
    gateway: { type: String, required: true, lowercase: true, index: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    merchantTransactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    gatewayTransactionId: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: [
        "created",
        "pending",
        "paid",
        "failed",
        "expired",
        "refunded",
        "partially_refunded",
      ],
      default: "created",
      index: true,
    },
    redirectUrl: String,
    gatewayResponse: mongoose.Schema.Types.Mixed,
    statusHistory: [
      { status: String, at: { type: Date, default: Date.now }, source: String },
    ],
    verifiedAt: Date,
  },
  { timestamps: true },
);
export default mongoose.models.AquaPaymentAttempt ||
  mongoose.model("AquaPaymentAttempt", PaymentAttemptSchema);
