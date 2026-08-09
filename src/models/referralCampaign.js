import mongoose from "mongoose";

const ReferralCampaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    referrerReward: { type: Number, required: true, min: 0 },
    referredReward: { type: Number, default: 0, min: 0 },
    minimumPaidOrder: { type: Number, default: 0, min: 0 },
    rewardDelayDays: { type: Number, default: 7, min: 0 },
    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["draft", "active", "paused", "archived"],
      default: "draft",
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
  },
  { timestamps: true },
);
export default mongoose.models.AquaReferralCampaign ||
  mongoose.model("AquaReferralCampaign", ReferralCampaignSchema);
