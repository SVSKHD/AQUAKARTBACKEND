import express from "express";
import CustomerProfileOperations from "../../controllers/crm/customerProfileSchemaCrud.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ message: "CRM customer profile v1 Status is Active" });
});

// Unified customer profiles
// source=online | offline | all
router.get("/", userAuth.checkAdmin, CustomerProfileOperations.listCustomerProfiles);

// Create customer profiles
// online -> AquaEcomUser, reflects in ecommerce app
// offline -> AquaInvoice customer shell / invoice customer profile
router.post("/online", userAuth.checkAdmin, CustomerProfileOperations.createOnlineProfile);
router.post("/offline", userAuth.checkAdmin, CustomerProfileOperations.createOfflineProfile);

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
router.patch(
  "/offline/:key",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOfflineProfile,
);
router.delete(
  "/offline/:key",
  userAuth.checkAdmin,
  CustomerProfileOperations.deleteOfflineProfile,
);

// Offline invoice review CRUD. Reviews are stored on AquaInvoice.review.
router.post(
  "/offline/:key/reviews",
  userAuth.checkAdmin,
  CustomerProfileOperations.createOfflineReview,
);
router.put(
  "/offline/:key/reviews/:invoiceId",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOfflineReview,
);
router.patch(
  "/offline/:key/reviews/:invoiceId",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOfflineReview,
);
router.delete(
  "/offline/:key/reviews/:invoiceId",
  userAuth.checkAdmin,
  CustomerProfileOperations.deleteOfflineReview,
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
router.patch(
  "/online/:id",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineProfile,
);
router.delete(
  "/online/:id",
  userAuth.checkAdmin,
  CustomerProfileOperations.deleteOnlineProfile,
);

// Online address CRUD. Addresses live in AquaEcomUser.addresses / selectedAddress.
router.put(
  "/online/:id/addresses",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineAddresses,
);
router.post(
  "/online/:id/addresses",
  userAuth.checkAdmin,
  CustomerProfileOperations.createOnlineAddress,
);
router.put(
  "/online/:id/addresses/:addressId",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineAddress,
);
router.patch(
  "/online/:id/addresses/:addressId",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineAddress,
);
router.delete(
  "/online/:id/addresses/:addressId",
  userAuth.checkAdmin,
  CustomerProfileOperations.deleteOnlineAddress,
);

// Online product review CRUD. Reviews live inside AquaProduct.reviews and reflect in ecommerce app.
router.post(
  "/online/:id/reviews",
  userAuth.checkAdmin,
  CustomerProfileOperations.createOnlineReview,
);
router.put(
  "/online/:id/reviews/:reviewId",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineReview,
);
router.patch(
  "/online/:id/reviews/:reviewId",
  userAuth.checkAdmin,
  CustomerProfileOperations.updateOnlineReview,
);
router.delete(
  "/online/:id/reviews/:reviewId",
  userAuth.checkAdmin,
  CustomerProfileOperations.deleteOnlineReview,
);

export default router;