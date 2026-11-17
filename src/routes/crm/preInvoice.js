import express from "express";
import { requirePermission } from "../../middleware/permissions.js";
import {
  createPreInvoice,
  createPreInvoiceLink,
  createQuotationLink,
  getPreInvoice,
  getPreInvoiceLink,
  getQuotationLink,
  listPreInvoices,
  moveQuotationToPreInvoice,
  revokePreInvoiceLink,
  revokeQuotationLink,
  updatePreInvoice,
} from "../../controllers/offlinePayments.js";

// CRM pre-invoices and admin-created payment links. Mounted at /v1/crm.
// See docs/OFFLINE_PAYMENT_LINKS.md.
const router = express.Router();

router.get(
  "/pre-invoices",
  ...requirePermission("preinvoices.read"),
  listPreInvoices,
);
router.post(
  "/pre-invoices",
  ...requirePermission("preinvoices.manage"),
  createPreInvoice,
);
router.get(
  "/pre-invoices/:id",
  ...requirePermission("preinvoices.read"),
  getPreInvoice,
);
router.patch(
  "/pre-invoices/:id",
  ...requirePermission("preinvoices.manage"),
  updatePreInvoice,
);
router.post(
  "/quotations/:id/pre-invoice",
  ...requirePermission("preinvoices.manage"),
  moveQuotationToPreInvoice,
);

router.get(
  "/pre-invoices/:id/payment-link",
  ...requirePermission("payments.link.manage"),
  getPreInvoiceLink,
);
router.post(
  "/pre-invoices/:id/payment-link",
  ...requirePermission("payments.link.manage"),
  createPreInvoiceLink,
);
router.delete(
  "/pre-invoices/:id/payment-link",
  ...requirePermission("payments.link.manage"),
  revokePreInvoiceLink,
);
router.get(
  "/quotations/:id/payment-link",
  ...requirePermission("payments.link.manage"),
  getQuotationLink,
);
router.post(
  "/quotations/:id/payment-link",
  ...requirePermission("payments.link.manage"),
  createQuotationLink,
);
router.delete(
  "/quotations/:id/payment-link",
  ...requirePermission("payments.link.manage"),
  revokeQuotationLink,
);

export default router;
