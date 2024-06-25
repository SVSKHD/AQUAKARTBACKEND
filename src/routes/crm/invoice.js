import express from "express";
import InvoiceOperations from "../../controllers/crm/invoice.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("invoice-status", async (req, res) => {
  res.json({ message: "Invoice Status v1 active" });
});

router.get("/all-invoices",userAuth.checkAdmin,InvoiceOperations.getInvoices)
router.get("/invoice/:id",InvoiceOperations.getInvoice)
router.get("/invoice/:id", userAuth.checkAdmin , InvoiceOperations.deleteInvoice)
router.post("/create/invoice", userAuth.checkAdmin , InvoiceOperations.createInvoice)
router.put("/update/invoice/:id" , userAuth.checkAdmin , InvoiceOperations.updateInvoice)


export default router;
