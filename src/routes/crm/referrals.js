import express from "express";
import * as controller from "../../controllers/referrals.js";
import { requirePermission } from "../../middleware/permissions.js";
const router = express.Router();
router.get(
  "/campaigns",
  ...requirePermission("referrals.read"),
  controller.listCampaigns,
);
router.post(
  "/campaigns",
  ...requirePermission("referrals.manage"),
  controller.createCampaign,
);
router.patch(
  "/campaigns/:id",
  ...requirePermission("referrals.manage"),
  controller.updateCampaign,
);
router.get(
  "/referrals",
  ...requirePermission("referrals.read"),
  controller.listReferrals,
);
router.get(
  "/rewards",
  ...requirePermission("rewards.read"),
  controller.listRewards,
);
router.patch(
  "/rewards/:id/status",
  ...requirePermission("rewards.manage"),
  controller.updateReward,
);
export default router;
