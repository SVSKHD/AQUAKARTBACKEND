import express from "express";
import serviceReminderController from "../controllers/serviceReminders.js";
import userAuth from "../middleware/user.js";

const router = express.Router();
router.get("/mine", userAuth.isLoggedIn, serviceReminderController.listMine);

export default router;
