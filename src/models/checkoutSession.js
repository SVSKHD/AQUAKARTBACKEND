import mongoose from "mongoose";

const CheckoutSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaEcomUser",
      required: true,
      index: true,
    },
    items: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaProduct" },
        name: String,
        category: mongoose.Schema.Types.ObjectId,
        unitPrice: Number,
        quantity: Number,
        lineTotal: Number,
      },
    ],
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaCoupon" },
    couponCode: String,
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    rewardCredit: { type: Number, default: 0 },
    deliveryCharge: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    payableAmount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: ["open", "consumed", "expired"],
      default: "open",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);
export default mongoose.models.AquaCheckoutSession ||
  mongoose.model("AquaCheckoutSession", CheckoutSessionSchema);
