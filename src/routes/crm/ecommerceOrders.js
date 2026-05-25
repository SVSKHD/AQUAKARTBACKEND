import express from "express";
import CRMEcommerceOrderOperations from "../../controllers/crm/ecommerceOrders.js";
import OrderInvoiceOperations from "../../controllers/crm/orderInvoice.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ message: "CRM ecommerce orders v1 status is active" });
});

router.get("/", userAuth.checkAdmin, CRMEcommerceOrderOperations.getOrders);
router.get("/today", userAuth.checkAdmin, CRMEcommerceOrderOperations.getTodayOrders);
router.get("/tomorrow", userAuth.checkAdmin, CRMEcommerceOrderOperations.getTomorrowOrders);
router.get("/:id", userAuth.checkAdmin, CRMEcommerceOrderOperations.getOrderById);
router.put("/:id", userAuth.checkAdmin, CRMEcommerceOrderOperations.updateOrder);
router.post(
  "/:orderId/create-invoice",
  userAuth.checkAdmin,
  OrderInvoiceOperations.createInvoiceFromEcommerceOrder,
);
router.patch("/:id/status", userAuth.checkAdmin, CRMEcommerceOrderOperations.updateOrderStatus);
router.put("/:id/status", userAuth.checkAdmin, CRMEcommerceOrderOperations.updateOrderStatus);

export default router;
