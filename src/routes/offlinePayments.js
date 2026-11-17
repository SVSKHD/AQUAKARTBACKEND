import express from "express";
import { rateLimit } from "express-rate-limit";
import verifyFirebaseToken from "../middleware/firebaseAuth.js";
import requireGoogleBackendSession from "../middleware/googleSession.js";
import {
  initiateOfflinePayment,
  offlinePaymentStatus,
  saveOfflineCustomer,
  viewOfflinePayment,
} from "../controllers/offlinePayments.js";

// Customer side of admin-created payment links (the /pay/{token} page).
// Mounted at /v1. See docs/OFFLINE_PAYMENT_LINKS.md.
const router = express.Router();

const limited = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many requests; try again in a minute",
  },
});
const signedIn = [verifyFirebaseToken, requireGoogleBackendSession];

router.get("/payments/offline/:token", limited, viewOfflinePayment);
router.post(
  "/payments/offline/:token/customer",
  limited,
  ...signedIn,
  saveOfflineCustomer,
);
router.post(
  "/payments/offline/:token/initiate",
  limited,
  ...signedIn,
  initiateOfflinePayment,
);
router.get(
  "/payments/offline/:token/status",
  limited,
  ...signedIn,
  offlinePaymentStatus,
);

export default router;
