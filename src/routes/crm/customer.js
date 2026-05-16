import express from "express";
import AdminCustomerOperations from "../../controllers/crm/customer.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ message: "Admin customer v1 Status is Active" });
});

// Customers CRUD
router.get("/", userAuth.checkAdmin, AdminCustomerOperations.listCustomers);
router.post("/", userAuth.checkAdmin, AdminCustomerOperations.createCustomer);
router.get("/:id", userAuth.checkAdmin, AdminCustomerOperations.getCustomerById);
router.put("/:id", userAuth.checkAdmin, AdminCustomerOperations.updateCustomer);
router.delete("/:id", userAuth.checkAdmin, AdminCustomerOperations.deleteCustomer);

// Customer Orders
router.get(
  "/:id/orders",
  userAuth.checkAdmin,
  AdminCustomerOperations.listCustomerOrders,
);
router.get(
  "/:id/orders/:orderId",
  userAuth.checkAdmin,
  AdminCustomerOperations.getCustomerOrder,
);
router.put(
  "/:id/orders/:orderId",
  userAuth.checkAdmin,
  AdminCustomerOperations.updateCustomerOrder,
);
router.delete(
  "/:id/orders/:orderId",
  userAuth.checkAdmin,
  AdminCustomerOperations.deleteCustomerOrder,
);

// Customer Reviews & Comments
router.get(
  "/:id/reviews",
  userAuth.checkAdmin,
  AdminCustomerOperations.listCustomerReviews,
);
router.put(
  "/:id/reviews/:productId/:reviewId",
  userAuth.checkAdmin,
  AdminCustomerOperations.updateCustomerReview,
);
router.delete(
  "/:id/reviews/:productId/:reviewId",
  userAuth.checkAdmin,
  AdminCustomerOperations.deleteCustomerReview,
);

export default router;
