import express from "express";
import axios from "axios";
import paymentOperations from "../controllers/phonepeGateway.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get(async (req, res) => {
  res.json({ message: "Phone Pe Status v1 active" });
});

router.post("/pay-phonepe", userAuth.isLoggedIn, paymentOperations.payPhonepe);

export default router;
