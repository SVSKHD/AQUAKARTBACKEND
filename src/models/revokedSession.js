import mongoose from "mongoose";

// Customer session tokens (JWT) cancelled by sign-out. Only a SHA-256 hash of
// the token is stored. Each row is removed by MongoDB once the token would
// have expired anyway (TTL index on expiresAt).
const RevokedSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaEcomUser" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

RevokedSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.RevokedSession ||
  mongoose.model("RevokedSession", RevokedSessionSchema);
