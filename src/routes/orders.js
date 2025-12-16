import express from "express";
import OrderOperations from "../controllers/order.js";
import userAuth from "../middleware/user.js";
import paymentOperations from "../controllers/phonepeGateway.js";
const router = express.Router();

router.post("/order/cod", OrderOperations.createCodOrder);
router.post("/order/pay", paymentOperations.payPhonepe);
router.get("/order/:id", OrderOperations.getOrdersById);
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
router.put("/order/user/:id", OrderOperations.updateOrder);

//admin routes
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
