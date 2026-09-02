import express from "express";
import serviceReminderController from "../controllers/serviceReminders.js";
import userAuth from "../middleware/user.js";

const router = express.Router();
router.get("/mine", userAuth.isLoggedIn, serviceReminderController.listMine);
router.get("/admin", userAuth.checkAdmin, serviceReminderController.listAdmin);
router.patch("/admin/:id/confirmation", userAuth.checkAdmin, serviceReminderController.updateConfirmation);
router.post("/admin/:id/resend", userAuth.checkAdmin, serviceReminderController.resend);
router.get("/confirm/:token", serviceReminderController.getPublicConfirmation);
router.post("/confirm/:token", serviceReminderController.confirmPublic);

export default router;
