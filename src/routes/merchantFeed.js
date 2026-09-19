import express from "express";
import { getGoogleMerchantFeed } from "../controllers/merchantFeed.js";

const router = express.Router();

router.get("/google-products.xml", getGoogleMerchantFeed);

export default router;
