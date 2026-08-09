import mongoose from "mongoose";

const CouponRedemptionSchema = new mongoose.Schema(
  {
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaCoupon",
      required: true,
      index: true,
    },
    code: { type: String, required: true, uppercase: true, index: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaEcomUser",
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaOrder",
      index: true,
    },
    checkoutSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaCheckoutSession",
      index: true,
    },
    subtotal: Number,
    discount: Number,
    status: {
      type: String,
      enum: ["reserved", "redeemed", "released", "reversed"],
      default: "reserved",
      index: true,
    },
    redeemedAt: Date,
  },
  { timestamps: true },
);

CouponRedemptionSchema.index({ couponId: 1, userId: 1, status: 1 });

export default mongoose.models.AquaCouponRedemption ||
  mongoose.model("AquaCouponRedemption", CouponRedemptionSchema);
