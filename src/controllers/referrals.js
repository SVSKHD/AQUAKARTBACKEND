import crypto from "crypto";
import Referral from "../models/referral.js";
import Campaign from "../models/referralCampaign.js";
import Reward from "../models/rewardLedger.js";
import { writeAudit } from "../services/audit.js";

const codeFor = (userId) =>
  `AQUA-${String(userId).slice(-5).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

export const getMine = async (req, res) => {
  let referral = await Referral.findOne({ referrerUserId: req.user._id }).sort({
    createdAt: 1,
  });
  if (!referral)
    referral = await Referral.create({
      code: codeFor(req.user._id),
      referrerUserId: req.user._id,
      status: "clicked",
    });
  const [history, rewards] = await Promise.all([
    Referral.find({ referrerUserId: req.user._id })
      .sort({ createdAt: -1 })
      .lean(),
    Reward.find({ userId: req.user._id }).sort({ createdAt: -1 }).lean(),
  ]);
  const balance = rewards
    .filter((item) => item.status === "approved")
    .reduce((sum, item) => sum + item.amount, 0);
  return res.json({
    success: true,
    data: { code: referral.code, history, rewards, balance },
  });
};

export const attribute = async (req, res) => {
  const code = String(req.body.code || "")
    .trim()
    .toUpperCase();
  const source = await Referral.findOne({ code }).sort({ createdAt: 1 });
  if (!source)
    return res
      .status(404)
      .json({ success: false, message: "Referral code not found" });
  if (String(source.referrerUserId) === String(req.user._id))
    return res
      .status(409)
      .json({ success: false, message: "Self-referral is not allowed" });
  try {
    const referral = await Referral.create({
      code,
      referrerUserId: source.referrerUserId,
      referredUserId: req.user._id,
      campaignId: source.campaignId,
      status: "signed_up",
      metadata: { source: req.body.source },
    });
    return res.status(201).json({ success: true, data: referral });
  } catch (error) {
    return res
      .status(error?.code === 11000 ? 409 : 400)
      .json({
        success: false,
        message:
          error?.code === 11000
            ? "This account is already attributed"
            : error.message,
      });
  }
};

const campaignFields = [
  "name",
  "referrerReward",
  "referredReward",
  "minimumPaidOrder",
  "rewardDelayDays",
  "startsAt",
  "endsAt",
  "status",
];
const pickCampaign = (body) =>
  Object.fromEntries(
    campaignFields
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );

export const listCampaigns = async (_req, res) =>
  res.json({
    success: true,
    data: await Campaign.find({}).sort({ createdAt: -1 }).lean(),
  });
export const createCampaign = async (req, res) => {
  const campaign = await Campaign.create({
    ...pickCampaign(req.body),
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });
  await writeAudit({
    req,
    action: "referral-campaign.create",
    resourceType: "referral-campaign",
    resourceId: campaign._id,
    after: campaign,
  });
  return res.status(201).json({ success: true, data: campaign });
};
export const updateCampaign = async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign)
    return res
      .status(404)
      .json({ success: false, message: "Campaign not found" });
  const before = campaign.toObject();
  Object.assign(campaign, pickCampaign(req.body), { updatedBy: req.user._id });
  await campaign.save();
  await writeAudit({
    req,
    action: "referral-campaign.update",
    resourceType: "referral-campaign",
    resourceId: campaign._id,
    before,
    after: campaign,
  });
  return res.json({ success: true, data: campaign });
};
export const listReferrals = async (_req, res) =>
  res.json({
    success: true,
    data: await Referral.find({}).sort({ createdAt: -1 }).limit(500).lean(),
  });
export const listRewards = async (_req, res) =>
  res.json({
    success: true,
    data: await Reward.find({}).sort({ createdAt: -1 }).limit(500).lean(),
  });
export const updateReward = async (req, res) => {
  if (!["approved", "rejected", "reversed"].includes(req.body.status))
    return res
      .status(400)
      .json({ success: false, message: "Invalid reward status" });
  const reward = await Reward.findById(req.params.id);
  if (!reward)
    return res
      .status(404)
      .json({ success: false, message: "Reward not found" });
  const before = reward.toObject();
  reward.status = req.body.status;
  reward.reason = req.body.reason;
  reward.approvedBy = req.user._id;
  await reward.save();
  await writeAudit({
    req,
    action: "reward.status",
    resourceType: "reward",
    resourceId: reward._id,
    before,
    after: reward,
  });
  return res.json({ success: true, data: reward });
};
