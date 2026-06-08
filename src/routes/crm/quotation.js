import express from "express";
import QuotationOperations from "../../controllers/crm/quotation.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ message: "Quotation v1 Status is Active" });
});

router.get("/", userAuth.checkAdmin, QuotationOperations.getQuotations);
router.post("/", userAuth.checkAdmin, QuotationOperations.createQuotation);

router.get(
  "/number/:quotationNo",
  userAuth.checkAdmin,
  QuotationOperations.getQuotationByNumber,
);
router.get(
  "/customer/:customerId",
  userAuth.checkAdmin,
  QuotationOperations.getQuotationsByCustomer,
);

router.get("/:id", userAuth.checkAdmin, QuotationOperations.getQuotationById);
router.put("/:id", userAuth.checkAdmin, QuotationOperations.updateQuotation);
router.patch(
  "/:id/status",
  userAuth.checkAdmin,
  QuotationOperations.updateQuotationStatus,
);
router.patch(
  "/:id/payment",
  userAuth.checkAdmin,
  QuotationOperations.updateQuotationPayment,
);
router.post(
  "/:id/convert-to-invoice",
  userAuth.checkAdmin,
  QuotationOperations.convertQuotationToInvoice,
);
router.delete("/:id", userAuth.checkAdmin, QuotationOperations.deleteQuotation);

export default router;
