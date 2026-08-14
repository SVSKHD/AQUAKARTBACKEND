import express from "express";
import InvoiceOperations from "../../controllers/crm/invoice.js";
import InvoiceDeliveryOperations from "../../controllers/crm/invoiceDelivery.js";
import InvoiceBackfillOperations from "../../controllers/crm/invoiceBackfill.js";
import PublicInvoiceLookupOperations from "../../controllers/crm/publicInvoiceLookup.js";
import optionalUserAuth from "../../middleware/optionalUser.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("invoice-status", async (req, res) => {
  res.json({ message: "Invoice Status v1 active" });
});

router.get(
  "/public/invoices/phone",
  optionalUserAuth,
  PublicInvoiceLookupOperations.getInvoicesByPhone,
);
router.get(
  "/admin/all-invoices",
  userAuth.checkAdmin,
  InvoiceOperations.getInvoices,
);
router.get("/admin/invoice", userAuth.checkAdmin, InvoiceOperations.getInvoice);
router.get(
  "/admin/invoice/dates",
  userAuth.checkAdmin,
  InvoiceOperations.getInvoicesByDate,
);
router.get(
  "/invoice/id/:id",
  userAuth.checkAdmin,
  InvoiceOperations.getInvoiceById,
);
router.get(
  "/admin/invoices/:id/view",
  userAuth.checkAdmin,
  InvoiceOperations.getAdminInvoiceView,
);
router.get(
  "/admin/invoices/:id/customer-view",
  userAuth.checkAdmin,
  InvoiceOperations.getCustomerInvoiceView,
);
// Backward-compatible route used by deployed CRM clients.
router.get(
  "/invoice/:id",
  userAuth.checkAdmin,
  InvoiceOperations.getInvoiceById,
);
router.get(
  "/invoice/phone/:phone",
  userAuth.checkAdmin,
  InvoiceOperations.getInvoiceByPhone,
);
// Deprecated public route removed: customer invoice access now requires a
// short-lived token through /v1/invoices/public/:id.
router.get(
  "/invoice-phone/:phone",
  userAuth.checkAdmin,
  InvoiceOperations.getInvoiceByPhone,
);
router.post(
  "/create/invoice",
  userAuth.checkAdmin,
  InvoiceOperations.createInvoice,
);
router.put(
  "/update/invoice/:id",
  userAuth.checkAdmin,
  InvoiceOperations.updateInvoice,
);
router.delete(
  "/delete/invoice/:id",
  userAuth.checkAdmin,
  InvoiceOperations.deleteInvoice,
);

router.get(
  "/admin/invoices/backfill/preview",
  userAuth.checkAdmin,
  InvoiceBackfillOperations.previewHistoricalInvoiceBackfill,
);
router.post(
  "/admin/invoices/backfill/run",
  userAuth.checkAdmin,
  InvoiceBackfillOperations.runHistoricalInvoiceBackfill,
);

router.post(
  "/notify/invoice-members",
  userAuth.checkAdmin,
  InvoiceOperations.NotifyInvoiceMembers,
);
router.post(
  "/notify/invoice/:id",
  userAuth.checkAdmin,
  InvoiceOperations.notifySpecificInvoiceMember,
);
router.post(
  "/notify/invoice/:id/email",
  userAuth.checkAdmin,
  InvoiceDeliveryOperations.sendInvoiceEmail,
);

export default router;
