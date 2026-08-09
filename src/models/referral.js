import mongoose from "mongoose";

const ReferralSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    referrerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaEcomUser",
      required: true,
      index: true,
    },
    referredUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaEcomUser",
      sparse: true,
      index: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaReferralCampaign",
      index: true,
    },
    status: {
      type: String,
      enum: [
        "clicked",
        "signed_up",
        "qualified",
        "rewarded",
        "rejected",
        "reversed",
      ],
      default: "clicked",
      index: true,
    },
    attributedAt: { type: Date, default: Date.now },
    qualifiedOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaOrder",
    },
    rejectionReason: String,
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);

ReferralSchema.index({ referredUserId: 1 }, { unique: true, sparse: true });
export default mongoose.models.AquaReferral ||
  mongoose.model("AquaReferral", ReferralSchema);
