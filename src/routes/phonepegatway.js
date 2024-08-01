import express from "express";
import axios from "axios";
import paymentOperations from "../controllers/phonepeGateway.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/",async (req, res) => {
  res.json({ message: "Phone Pe Status v1 active" });
});

router.post("/pay-phonepe", paymentOperations.payPhonepe);
// router.post("/pay-phonepe/verify", paymentOperations.handlePhonePeData)
router.post("/phonepe-verify/:id", paymentOperations.handlePhoneOrderCheck)
export default router;
