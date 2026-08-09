import mongoose from "mongoose";

const PaymentAttemptSchema = new mongoose.Schema(
  {
    checkoutSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaCheckoutSession",
      required: true,
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
