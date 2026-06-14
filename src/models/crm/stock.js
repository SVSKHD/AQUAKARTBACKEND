import mongoose from "mongoose";

const stockSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaProduct",
      required: true,
      index: true,
      unique: true,
    },
    productName: {
      type: String,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    distributorPrice: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    totalValue: {
      type: Number,
      default: 0,
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

const AquaStock = mongoose.models.AquaStock || mongoose.model("AquaStock", stockSchema);
export default AquaStock;
