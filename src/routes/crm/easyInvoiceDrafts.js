import express from "express";
import Drafts from "../../controllers/crm/easyInvoiceDrafts.js";
import { requirePermission } from "../../middleware/permissions.js";

// Mounted at /v1/crm/easy-invoice-drafts. Shared by all staff who manage invoices.
const router = express.Router();

router.use(requirePermission("invoices.manage"));

router.get("/", Drafts.list);
router.post("/", Drafts.create);
router.get("/:id", Drafts.get);
router.put("/:id", Drafts.save);
router.post("/:id/heartbeat", Drafts.heartbeat);
router.post("/:id/claim", Drafts.claim);
router.post("/:id/release", Drafts.release);
router.post("/:id/complete", Drafts.complete);
router.delete("/:id", Drafts.discard);

export default router;
