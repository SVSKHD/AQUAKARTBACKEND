import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// Admin-maintained Porter / Rapido rates used only for comparison. These are
// not live quotes: an admin copies them from the provider's published fares
// and records where and when (sourceNote, observedAt).
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

export const BENCHMARK_PROVIDERS = ["porter", "rapido", "other"];

const TransportBenchmarkSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: BENCHMARK_PROVIDERS,
      required: true,
      index: true,
    },
    vehicleType: { type: String, required: true, trim: true },
    label: { type: String, trim: true, default: "" },
    baseFare: { type: Number, required: true, min: 0 },
    includedKm: { type: Number, default: 0, min: 0 },
    perKm: { type: Number, required: true, min: 0 },
    perMinute: { type: Number, default: 0, min: 0 },
    minimumFare: { type: Number, default: 0, min: 0 },
    sourceNote: { type: String, trim: true, default: "" },
    observedAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: ObjectId, ref: "AquaAdminUser" },
    history: [historySchema],
  },
  { timestamps: true },
);

export default mongoose.models.AquaTransportBenchmark ||
  mongoose.model("AquaTransportBenchmark", TransportBenchmarkSchema);
