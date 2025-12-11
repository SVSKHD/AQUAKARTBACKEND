import mongoose from "mongoose";

const stockSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
      unique: true,
    },
    productName:{
      type: String,
      unique: true,
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
  { timestamps: true }
);



const AquaStock = mongoose.model("AquaStock", stockSchema);
export default AquaStock;