import express from "express";
import PaymentOperations from "../../controllers/crm/paymentLink.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();
router.get("/payment-api-link-status", (req, res) => {
  res.json({ message: "Aquakart v1 status is active" });
});

router.post(
  "/phonepe/payment-link",
  userAuth.checkAdmin,
  PaymentOperations.createPaymentLink,
);

export default router;
