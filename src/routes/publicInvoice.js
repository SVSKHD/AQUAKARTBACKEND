import express from "express";
import { rateLimit } from "express-rate-limit";
import publicInvoiceController from "../controllers/publicInvoice.js";
import requireInvoiceAccess from "../middleware/invoiceAccess.js";
import verifyFirebaseToken from "../middleware/firebaseAuth.js";
import requireGoogleBackendSession from "../middleware/googleSession.js";

const router = express.Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "private, no-store, max-age=0");
  next();
});
const limiter = (windowMs, limit) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests. Please try again later.",
    },
  });

router.post(
  "/lookup",
  limiter(15 * 60 * 1000, 5),
  verifyFirebaseToken,
  requireGoogleBackendSession,
  publicInvoiceController.lookup,
);
router.post(
  "/request-access",
  limiter(60 * 60 * 1000, 3),
  publicInvoiceController.requestAccess,
);
router.post(
  "/exchange",
  limiter(15 * 60 * 1000, 5),
  publicInvoiceController.exchange,
);
router.post(
  "/login",
  limiter(15 * 60 * 1000, 5),
  verifyFirebaseToken,
  requireGoogleBackendSession,
  publicInvoiceController.loginAccess,
);
router.post(
  "/:id/login",
  limiter(15 * 60 * 1000, 5),
  verifyFirebaseToken,
  publicInvoiceController.loginDirectAccess,
);
router.get("/", requireInvoiceAccess, publicInvoiceController.list);
router.get("/:id", requireInvoiceAccess, publicInvoiceController.getById);
router.post(
  "/:id/claim",
  limiter(15 * 60 * 1000, 5),
  requireInvoiceAccess,
  publicInvoiceController.claimById,
);
router.patch(
  "/:id/email",
  limiter(15 * 60 * 1000, 5),
  requireInvoiceAccess,
  publicInvoiceController.updateEmailById,
);
router.post(
  "/:id/share/email",
  limiter(24 * 60 * 60 * 1000, 3),
  requireInvoiceAccess,
  publicInvoiceController.emailById,
);
router.get(
  "/:id/share/whatsapp",
  requireInvoiceAccess,
  publicInvoiceController.whatsappStatusById,
);
router.post(
  "/:id/share/whatsapp",
  limiter(24 * 60 * 60 * 1000, 3),
  requireInvoiceAccess,
  publicInvoiceController.whatsappById,
);
router.post(
  "/:id/email",
  limiter(24 * 60 * 60 * 1000, 3),
  requireInvoiceAccess,
  publicInvoiceController.emailById,
);
router.post(
  "/:id/reviews",
  limiter(60 * 60 * 1000, 20),
  requireInvoiceAccess,
  publicInvoiceController.reviewProductByInvoice,
);

export default router;
