import express from "express";
import CustomerProfileOperations from "../../controllers/crm/customerProfile.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ message: "CRM customer profile v1 Status is Active" });
});

// Unified customer profiles
// source=online | offline | all
router.get("/", userAuth.checkAdmin, CustomerProfileOperations.listCustomerProfiles);

// Offline invoice customers are grouped from AquaInvoice by phone/email.
router.get(
  "/offline/:key",
  userAuth.checkAdmin,
  CustomerProfileOperations.getOfflineProfile,
);
router.put(
  "/offline/:key",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOfflineProfile,
);

// Online ecommerce users. Updates here write to AquaEcomUser and reflect in ecom app.
router.get(
  "/online/:id",
  userAuth.checkAdmin,
  CustomerProfileOperations.getOnlineProfile,
);
router.put(
  "/online/:id",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineProfile,
);
router.put(
  "/online/:id/addresses",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineAddresses,
);

export default router;
