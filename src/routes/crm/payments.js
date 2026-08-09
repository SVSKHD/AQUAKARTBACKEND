import express from "express";
import {
  listAdminPayments,
  reconcile,
  listGateways,
  upsertGateway,
} from "../../controllers/payments.js";
import { requirePermission } from "../../middleware/permissions.js";
const router = express.Router();
router.get(
  "/payments",
  ...requirePermission("payments.read"),
  listAdminPayments,
);
router.post(
  "/payments/:id/reconcile",
  ...requirePermission("payments.reconcile"),
  reconcile,
);
router.get(
  "/payment-gateways",
  ...requirePermission("gateways.read"),
  listGateways,
);
router.put(
  "/payment-gateways/:key",
  ...requirePermission("gateways.manage"),
  upsertGateway,
);
export default router;
