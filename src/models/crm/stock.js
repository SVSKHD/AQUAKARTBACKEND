import mongoose from "mongoose";

const stockSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
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


stockSchema.pre("save", function (next) {
  this.totalValue = this.quantity * this.distributorPrice;
  this.lastUpdated = Date.now();
  next();
});


stockSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate();

  if (update.quantity || update.distributorPrice) {
    const qty = update.quantity ?? this._update.$set?.quantity;
    const price = update.distributorPrice ?? this._update.$set?.distributorPrice;

    if (qty !== undefined && price !== undefined) {
      update.totalValue = qty * price;
      update.lastUpdated = Date.now();
    }
  }

  next();
});

const AquaStock = mongoose.model("AquaStock", stockSchema);
export default AquaStock;