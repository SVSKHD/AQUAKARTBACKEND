import express from "express";
import CRMOrderOperations from "../../controllers/crm/order.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ message: "CRM orders v1 status is active" });
});

router.get("/", userAuth.checkAdmin, CRMOrderOperations.getOrders);
router.get("/today", userAuth.checkAdmin, CRMOrderOperations.getTodayOrders);
router.get("/tomorrow", userAuth.checkAdmin, CRMOrderOperations.getTomorrowOrders);
router.get("/range", userAuth.checkAdmin, CRMOrderOperations.getOrdersByDateRange);
router.get("/:id", userAuth.checkAdmin, CRMOrderOperations.getOrderById);

router.post("/", userAuth.checkAdmin, CRMOrderOperations.createOrder);
router.put("/:id", userAuth.checkAdmin, CRMOrderOperations.updateOrder);
router.patch("/:id/status", userAuth.checkAdmin, CRMOrderOperations.updateOrderStatus);

export default router;
