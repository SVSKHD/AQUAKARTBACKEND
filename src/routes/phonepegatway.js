import express from "express";
import paymentOperations from "../controllers/phonepeGateway.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/", async (req, res) => {
  res.json({ message: "Phone Pe Status v1 active" });
});

// router.post("/pay-phonepe", userAuth.isLoggedIn, paymentOperations.resolvePhonePeEnv);

// router.post("/phonepe-verify/:id", paymentOperations.handlePhoneOrderCheck);
export default router;
