import express from "express";
import rateLimit from "express-rate-limit";
import {
  requireAnyPermission,
  requirePermission,
} from "../../middleware/permissions.js";
import {
  approvePaymentException,
  cancelTransit,
  compareRates,
  correctDelivery,
  createBenchmark,
  createRateCard,
  getTransit,
  getWarehouse,
  listBenchmarks,
  listRateCards,
  listSettlements,
  listTransits,
  myPayouts,
  parseText,
  preview,
  recordCollection,
  report,
  retryInvoiceDelivery,
  reviewCollection,
  setWarehouse,
  settle,
  submit,
  updateBenchmark,
  updateRateCard,
} from "../../controllers/crm/transit.js";

// Transit (docs/TRANSIT.md). Mounted at /v1/crm/transit.
// Permissions are enforced here; the service also checks ownership (a
// transporter only sees their own deliveries) and admin-only actions.
const router = express.Router();

const OPERATE = "transit.operate";
const READ = "transit.read";
const MANAGE = "transit.manage";
const SETTLE = "transit.settle";

// Gemini and Google Maps calls cost money: limit them per staff account.
const paidCalls = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Runs after staff authentication, so req.user is always set.
  keyGenerator: (req) => `staff:${req.user._id}`,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many requests. Wait a minute.",
  },
});

// ---- Transporter workflow ----
router.post("/parse", ...requirePermission(OPERATE), paidCalls, parseText);
router.post("/preview", ...requirePermission(OPERATE), paidCalls, preview);
router.post("/transits", ...requirePermission(OPERATE), paidCalls, submit);
router.get("/transits", ...requireAnyPermission(OPERATE, READ), listTransits);
router.get("/transits/:id", ...requireAnyPermission(OPERATE, READ), getTransit);
router.post(
  "/transits/:id/collections",
  ...requireAnyPermission(OPERATE, MANAGE),
  recordCollection,
);
router.post(
  "/transits/:id/invoice-delivery/retry",
  ...requireAnyPermission(OPERATE, MANAGE),
  retryInvoiceDelivery,
);
router.get("/payouts/mine", ...requirePermission(OPERATE), myPayouts);
router.get("/warehouse", ...requireAnyPermission(OPERATE, READ), getWarehouse);

// ---- Admin ----
router.put("/warehouse", ...requirePermission(MANAGE), setWarehouse);
router.get("/pricing", ...requireAnyPermission(READ, MANAGE), listRateCards);
router.post("/pricing", ...requirePermission(MANAGE), createRateCard);
router.patch("/pricing/:id", ...requirePermission(MANAGE), updateRateCard);
router.get(
  "/benchmarks",
  ...requireAnyPermission(READ, MANAGE),
  listBenchmarks,
);
router.post("/benchmarks", ...requirePermission(MANAGE), createBenchmark);
router.patch("/benchmarks/:id", ...requirePermission(MANAGE), updateBenchmark);
router.get(
  "/comparisons",
  ...requireAnyPermission(READ, MANAGE),
  paidCalls,
  compareRates,
);
router.post(
  "/transits/:id/collections/:collectionId/review",
  ...requirePermission(MANAGE),
  reviewCollection,
);
router.post(
  "/transits/:id/payment-exception",
  ...requirePermission(MANAGE),
  approvePaymentException,
);
router.post(
  "/transits/:id/corrections",
  ...requirePermission(MANAGE),
  paidCalls,
  correctDelivery,
);
router.post(
  "/transits/:id/cancel",
  ...requirePermission(MANAGE),
  cancelTransit,
);
router.post("/settlements", ...requirePermission(SETTLE), settle);
router.get(
  "/settlements",
  ...requireAnyPermission(READ, SETTLE),
  listSettlements,
);
router.get("/reports/summary", ...requirePermission(READ), report);

export default router;
