import express from "express";
import LeadOperations from "../../controllers/crm/lead.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", userAuth.checkAdmin, (req, res) => {
  res.json({ message: "CRM Leads API is active" });
});

router.get("/", userAuth.checkAdmin, LeadOperations.getLeads);
router.post("/", userAuth.checkAdmin, LeadOperations.createLead);
router.get("/:id", userAuth.checkAdmin, LeadOperations.getLeadById);
router.put("/:id", userAuth.checkAdmin, LeadOperations.updateLead);
router.delete("/:id", userAuth.checkAdmin, LeadOperations.deleteLead);

export default router;
