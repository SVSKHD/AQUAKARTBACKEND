import express from "express";
import DealOperations from "../../controllers/crm/deal.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", userAuth.checkAdmin, (req, res) => {
  res.json({ message: "CRM Deals API is active" });
});

router.get("/", userAuth.checkAdmin, DealOperations.getDeals);
router.post("/", userAuth.checkAdmin, DealOperations.createDeal);
router.get("/:id", userAuth.checkAdmin, DealOperations.getDealById);
router.put("/:id", userAuth.checkAdmin, DealOperations.updateDeal);
router.delete("/:id", userAuth.checkAdmin, DealOperations.deleteDeal);

export default router;
