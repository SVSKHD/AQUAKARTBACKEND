import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// The route origin for Transit. Exactly one warehouse is active; replacing it
// deactivates the old one, which stays for history. Transit records keep their
// own snapshot of the warehouse they were routed from.
const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: ObjectId, ref: "AquaAdminUser" },
    action: String,
    note: String,
  },
  { _id: false },
);

const TransitWarehouseSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    location: {
      lat: { type: Number, required: true, min: -90, max: 90 },
      lng: { type: Number, required: true, min: -180, max: 180 },
    },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: ObjectId, ref: "AquaAdminUser" },
    history: [historySchema],
  },
  { timestamps: true },
);

// At most one active warehouse.
TransitWarehouseSchema.index(
  { isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

export default mongoose.models.AquaTransitWarehouse ||
  mongoose.model("AquaTransitWarehouse", TransitWarehouseSchema);
