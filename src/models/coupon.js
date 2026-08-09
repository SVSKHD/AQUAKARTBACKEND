import mongoose from "mongoose";

const CouponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    description: { type: String, trim: true, default: "" },
    discountType: {
      type: String,
      enum: ["percentage", "fixed"],
      default: "percentage",
    },
    discountValue: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, min: 0, default: null },
    minimumOrder: { type: Number, min: 0, default: 0 },
    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date, required: true },
    usageLimit: { type: Number, min: 1, default: null },
    perUserLimit: { type: Number, min: 1, default: 1 },
    usageCount: { type: Number, min: 0, default: 0 },
    firstOrderOnly: { type: Boolean, default: false },
    stackable: { type: Boolean, default: false },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "AquaProduct" }],
    categoryIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "AquaCategory" },
    ],
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "AquaEcomUser" }],
    status: {
      type: String,
      enum: ["draft", "active", "paused", "archived"],
      default: "draft",
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    // Legacy fields kept during e-commerce migration.
    discountPercentage: Number,
    validity: Date,
    conditions: String,
  },
  { timestamps: true },
);

CouponSchema.pre("validate", function normalizeLegacyCoupon() {
  this.code = String(this.code || "")
    .trim()
    .toUpperCase();
  if (
    this.discountValue === undefined &&
    this.discountPercentage !== undefined
  ) {
    this.discountType = "percentage";
    this.discountValue = this.discountPercentage;
  }
  if (!this.endsAt && this.validity) this.endsAt = this.validity;
});

export default mongoose.models.AquaCoupon ||
  mongoose.model("AquaCoupon", CouponSchema);
