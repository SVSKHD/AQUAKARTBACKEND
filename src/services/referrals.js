import Referral from "../models/referral.js";
import Campaign from "../models/referralCampaign.js";
import Reward from "../models/rewardLedger.js";

export const qualifyReferralForPaidOrder = async ({
  userId,
  orderId,
  amount,
}) => {
  const referral = await Referral.findOne({
    referredUserId: userId,
    status: "signed_up",
  });
  if (!referral) return null;
  const now = new Date();
  const campaign = referral.campaignId
    ? await Campaign.findById(referral.campaignId)
    : await Campaign.findOne({
        status: "active",
        startsAt: { $lte: now },
        endsAt: { $gte: now },
      }).sort({ createdAt: -1 });
  if (!campaign || amount < campaign.minimumPaidOrder) return null;
  referral.campaignId = campaign._id;
  referral.qualifiedOrderId = orderId;
  referral.status = "qualified";
  await referral.save();
  const availableAt = new Date(
    Date.now() + campaign.rewardDelayDays * 24 * 60 * 60 * 1000,
  );
  const rewards = [];
  if (campaign.referrerReward > 0) {
    rewards.push({
      userId: referral.referrerUserId,
      referralId: referral._id,
      amount: campaign.referrerReward,
      type: "credit",
      status: "pending",
      availableAt,
      reason: "Qualified referral order",
    });
  }
  if (campaign.referredReward > 0) {
    rewards.push({
      userId: referral.referredUserId,
      referralId: referral._id,
      amount: campaign.referredReward,
      type: "credit",
      status: "pending",
      availableAt,
      reason: "Referred first paid order",
    });
  }
  if (rewards.length) await Reward.insertMany(rewards);
  return referral;
};
