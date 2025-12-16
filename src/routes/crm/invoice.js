import express from "express";
import InvoiceOperations from "../../controllers/crm/invoice.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("invoice-status", async (req, res) => {
  res.json({ message: "Invoice Status v1 active" });
});

router.get("/admin/all-invoices", InvoiceOperations.getInvoices);
router.get("/admin/invoice", userAuth.checkAdmin, InvoiceOperations.getInvoice);
router.get(
  "/admin/invoice/dates",
  userAuth.checkAdmin,
  InvoiceOperations.getInvoicesByDate,
);
router.get("/invoice/:id", InvoiceOperations.getInvoiceById);
router.get("/invoice/:phone", InvoiceOperations.getInvoiceByPhone);
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

router.post("/notify/invoice-members", InvoiceOperations.NotifyInvoiceMembers);

export default router;
