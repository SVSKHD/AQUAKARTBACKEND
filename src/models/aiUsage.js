import mongoose from "mongoose";

// Daily storefront AI question counts, one document per subject per IST day.
const AiUsageSchema = new mongoose.Schema(
  {
    // "user:<ecomUserId>" or "ip:<address>"
    key: { type: String, required: true },
    day: { type: String, required: true }, // YYYY-MM-DD in Asia/Kolkata
    tier: { type: String, enum: ["guest", "user"], required: true },
    count: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

AiUsageSchema.index({ key: 1, day: 1 }, { unique: true });
AiUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.AquaAiUsage ||
  mongoose.model("AquaAiUsage", AiUsageSchema);
