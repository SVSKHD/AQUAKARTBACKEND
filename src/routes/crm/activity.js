import express from "express";
import ActivityOperations from "../../controllers/crm/activity.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", userAuth.checkAdmin, (req, res) => {
  res.json({ message: "CRM Activities API is active" });
});

router.get("/", userAuth.checkAdmin, ActivityOperations.getActivities);
router.post("/", userAuth.checkAdmin, ActivityOperations.createActivity);
router.get("/:id", userAuth.checkAdmin, ActivityOperations.getActivityById);
router.put("/:id", userAuth.checkAdmin, ActivityOperations.updateActivity);
router.delete("/:id", userAuth.checkAdmin, ActivityOperations.deleteActivity);

export default router;
