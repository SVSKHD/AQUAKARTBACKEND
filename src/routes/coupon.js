import express from "express";
import controller from "../controllers/coupon.js";
import { requirePermission } from "../middleware/permissions.js";

const router = express.Router();
router.get("/coupon-status", (_req, res) =>
  res.json({ success: true, status: "active" }),
);
router.get("/coupons/active", controller.getActiveCoupons);
router.post(
  "/create-coupon",
  ...requirePermission("coupons.manage"),
  controller.createCoupon,
);
router.get(
  "/all-coupons",
  ...requirePermission("coupons.read"),
  controller.getCoupons,
);
router.get(
  "/coupon/:id",
  ...requirePermission("coupons.read"),
  controller.getCouponById,
);
router.put(
  "/coupon-update/:id",
  ...requirePermission("coupons.manage"),
  controller.updateCoupon,
);
router.delete(
  "/coupon-delete/:id",
  ...requirePermission("coupons.manage"),
  controller.deleteCoupon,
);

export default router;
