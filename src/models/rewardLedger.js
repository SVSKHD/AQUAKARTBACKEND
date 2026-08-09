import mongoose from "mongoose";

const RewardLedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaEcomUser",
      required: true,
      index: true,
    },
    referralId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaReferral",
      index: true,
    },
    amount: { type: Number, required: true },
    type: {
      type: String,
      enum: ["credit", "debit", "reversal"],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "reversed", "used"],
      default: "pending",
      index: true,
    },
    availableAt: Date,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    reason: String,
  },
  { timestamps: true },
);
export default mongoose.models.AquaRewardLedger ||
  mongoose.model("AquaRewardLedger", RewardLedgerSchema);
