import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// Admin-managed transport pricing. A rate card is a full set of distance
// tiers plus the cash collection incentive. Tiers are contiguous from 0 km and
// the last one is open-ended (validated in src/services/transit/rules.js).
// The card in force is the active one with the latest effectiveFrom that has
// started and not ended. Cards are not edited in place: a price change is a
// new card, so every transit's snapshot can be traced to the card it used.
const tierSchema = new mongoose.Schema(
  {
    minKm: { type: Number, required: true, min: 0 },
    // null = no upper bound (last tier only).
    maxKm: { type: Number, default: null },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: ObjectId, ref: "AquaAdminUser" },
    action: String,
    before: Mixed,
    after: Mixed,
  },
  { _id: false },
);

const TransitRateCardSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    currency: { type: String, default: "INR" },
    tiers: { type: [tierSchema], required: true },
    // Added to the transporter's payout once per transit when they confirm a
    // cash collection.
    cashIncentive: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, required: true, index: true },
    effectiveTo: { type: Date, default: null },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    createdBy: { type: ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: ObjectId, ref: "AquaAdminUser" },
    history: [historySchema],
  },
  { timestamps: true },
);

export default mongoose.models.AquaTransitRateCard ||
  mongoose.model("AquaTransitRateCard", TransitRateCardSchema);
