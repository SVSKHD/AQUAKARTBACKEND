import express from "express";
import StorefrontStats from "../controllers/storefrontStats.js";

const router = express.Router();

router.get("/stats", StorefrontStats.getStorefrontStats);
router.get("/recent-purchases", StorefrontStats.getRecentPurchases);

export default router;
