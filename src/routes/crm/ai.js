import express from "express";
import AIOperations from "../../controllers/ai.js";
import AIInvoice from "../../controllers/crm/aiInvoice.js";
import {
  authenticateStaff,
  staffHasPermission,
} from "../../middleware/permissions.js";

const router = express.Router();

// CRM AI has no usage limits (staff only).
const canManageInvoices = (req, res, next) =>
  staffHasPermission(req.user, "invoices.manage")
    ? next()
    : res.status(403).json({
        success: false,
        message: "Insufficient permission",
        required: ["invoices.manage"],
      });

router.use(authenticateStaff);

router.get("/status", AIOperations.status);
router.post("/generate", AIOperations.crmGenerate);
router.post("/generate/stream", AIOperations.crmGenerateStream);

// AI invoice assistant
const invoice = express.Router();
invoice.use(canManageInvoices);
invoice.get("/products", AIInvoice.searchProducts);
invoice.get("/sessions", AIInvoice.listSessions);
invoice.post("/sessions", AIInvoice.createSession);
invoice.get("/sessions/:id", AIInvoice.getSession);
invoice.post("/sessions/:id/messages", AIInvoice.sendMessage);
invoice.patch("/sessions/:id/draft", AIInvoice.updateDraft);
invoice.post("/sessions/:id/create", AIInvoice.createInvoice);
invoice.post("/sessions/:id/email", AIInvoice.emailInvoice);
invoice.delete("/sessions/:id", AIInvoice.cancelSession);
router.use("/invoice", invoice);

export default router;
