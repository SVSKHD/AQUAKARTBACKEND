import express from "express";
import controller from "../../controllers/coupon.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
router.get("/", ...requirePermission("coupons.read"), controller.getCoupons);
router.post(
  "/",
  ...requirePermission("coupons.manage"),
  controller.createCoupon,
);
router.get(
  "/:id",
  ...requirePermission("coupons.read"),
  controller.getCouponById,
);
router.patch(
  "/:id",
  ...requirePermission("coupons.manage"),
  controller.updateCoupon,
);
router.delete(
  "/:id",
  ...requirePermission("coupons.manage"),
  controller.deleteCoupon,
);
router.get(
  "/:id/redemptions",
  ...requirePermission("coupons.read"),
  controller.getRedemptions,
);
export default router;
