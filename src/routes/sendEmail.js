import express from "express";
import SendEmail from "../controllers/sendEmail.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.post("/send-email", userAuth.checkAdmin, SendEmail);

export default router;
