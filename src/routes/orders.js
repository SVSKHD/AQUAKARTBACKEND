import express from "express";
import OrderOperations from "../controllers/order.js";
import userAuth from "../middleware/user.js";
import paymentOperations from "../controllers/phonepeGateway.js";

const router = express.Router();

// Legacy storefront order routes (kept until the storefront uses
// /v1/checkout). Prices and totals are computed on the server.
router.post("/order/cod", userAuth.isLoggedIn, OrderOperations.createCodOrder);
router.post("/order/pay", userAuth.isLoggedIn, paymentOperations.payPhonepe);
// PhonePe's callback: public, but the handler re-checks status with PhonePe.
router.post("/phonepe-verify/:id", paymentOperations.handlePhoneOrderCheck);
router.get(
  "/order/:id",
  userAuth.customerOrAdmin,
  OrderOperations.getOrdersById,
);
router.get(
  "/orders/user/:id",
  userAuth.isLoggedIn,
  OrderOperations.getOrdersByUserId,
);
router.get(
  "/order/transaction-id/:id",
  userAuth.isLoggedIn,
  OrderOperations.getOrderByTransactionId,
);
// Customers may cancel or change delivery details of their own order only.
router.put(
  "/order/user/:id",
  userAuth.isLoggedIn,
  OrderOperations.updateOwnOrder,
);

// admin routes
router.get(
  "/admin/orders",
  userAuth.checkAdmin,
  OrderOperations.AdminGetOrders,
);
router.put(
  "/admin/order/:id",
  userAuth.checkAdmin,
  OrderOperations.updateOrder,
);
router.delete(
  "/admin/order/:id",
  userAuth.checkAdmin,
  OrderOperations.deleteOrderByAdmin,
);
// update orders
// delete orders

export default router;
