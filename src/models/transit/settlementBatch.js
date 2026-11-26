import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// One admin payout run covering one or more transits. The transits carry the
// settlement too; the batch is the audit record of who paid what, when.
const TransitSettlementBatchSchema = new mongoose.Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["processing", "done", "empty"],
      default: "processing",
    },
    paymentReference: { type: String, required: true, trim: true },
    note: { type: String, default: "" },
    requestedTransitIds: [{ type: ObjectId, ref: "AquaTransit" }],
    settledTransitIds: [{ type: ObjectId, ref: "AquaTransit" }],
    skipped: [
      {
        _id: false,
        transitId: { type: ObjectId, ref: "AquaTransit" },
        reason: String,
      },
    ],
    totals: {
      count: { type: Number, default: 0 },
      baseCharge: { type: Number, default: 0 },
      cashIncentive: { type: Number, default: 0 },
      totalPayable: { type: Number, default: 0 },
    },
    byTransporter: [
      {
        _id: false,
        transporterId: { type: ObjectId, ref: "AquaAdminUser" },
        count: Number,
        totalPayable: Number,
      },
    ],
    settledBy: { type: ObjectId, ref: "AquaAdminUser", required: true },
    settledAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.models.AquaTransitSettlementBatch ||
  mongoose.model("AquaTransitSettlementBatch", TransitSettlementBatchSchema);
