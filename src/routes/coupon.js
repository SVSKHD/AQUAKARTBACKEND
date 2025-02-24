import express from "express";
import AquaCouponOperations from "../controllers/coupon.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/coupon-status", AquaCouponOperations.AquaCouponTest);
router.post(
  "/create-coupon",
  userAuth.checkAdmin,
  AquaCouponOperations.createCoupon,
);
router.get("/all-coupons", AquaCouponOperations.getCoupons);
router.get(
  "/coupon/:id",
  userAuth.checkAdmin,
  AquaCouponOperations.getCouponById,
);
router.put(
  "/coupon-update/:id",
  userAuth.checkAdmin,
  AquaCouponOperations.updateCoupon,
);
router.delete(
  "/coupon-delete/:id",
  userAuth.checkAdmin,
  AquaCouponOperations.deleteCoupon,
);

export default router;
