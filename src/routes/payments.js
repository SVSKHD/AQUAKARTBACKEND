import express from "express";
import userAuth from "../middleware/user.js";
import {
  methods,
  createPayment,
  getPayment,
  phonePeWebhook,
  phonePeWebhookV2,
} from "../controllers/payments.js";
const router = express.Router();
router.get("/checkout/payment-methods", userAuth.isLoggedIn, methods);
router.post("/payments", userAuth.isLoggedIn, createPayment);
router.get("/payments/:id", userAuth.isLoggedIn, getPayment);
router.post("/webhooks/payments/phonepe/:transactionId", phonePeWebhook);
// PhonePe v2: one dashboard-configured webhook for every payment.
router.post("/webhooks/payments/phonepe", phonePeWebhookV2);
export default router;
