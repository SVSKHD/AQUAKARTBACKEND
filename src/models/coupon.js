import mongoose from "mongoose";

const AquaCouponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      validate: {
        validator: function (v) {
          // Ensures the code starts with "AQUA-"
          return /^AQUA-/.test(v);
        },
        message: (props) =>
          `${props.value} is not a valid coupon code! Coupon codes must start with 'AQUA-'`,
      },
    },
    description: {
      type: String,
    },
    discountPercentage: {
      type: Number,
      required: true,
    },
    validity: {
      type: Date,
      required: true,
    },
    conditions: {
      type: String, // Can be expanded based on need
    },
  },
  {
    timestamps: true,
  },
);

const AquaCoupon =
  mongoose.models.AquaCoupon || mongoose.model("AquaCoupon", AquaCouponSchema);

export default AquaCoupon;