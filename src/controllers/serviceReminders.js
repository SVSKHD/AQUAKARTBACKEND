import AquaInvoice from "../models/crm/invoice.js";
import AquaProduct from "../models/product.js";
import {
  getAnnualDueDates,
  getNextDueDate,
  getWarrantyDates,
  parseInvoicePurchaseDate,
  resolveRegenerationPolicy,
} from "../services/serviceReminders.js";
import { normalizeEmail, normalizeIndianPhone } from "../utils/invoiceAccess.js";

const listMine = async (req, res) => {
  try {
    const ownership = [];
    if (req.user.firebaseUid) ownership.push({ firebaseUid: req.user.firebaseUid });
    const email = normalizeEmail(req.user.email);
    if (email) ownership.push({ customerEmailNormalized: email });
    const phone = normalizeIndianPhone(req.user.phone);
    if (phone) ownership.push({ customerPhoneNormalized: phone });
    if (!ownership.length) return res.json({ success: true, data: [] });

    const invoices = await AquaInvoice.find({
      quotation: { $ne: true },
      $or: ownership,
    }).sort({ createdAt: -1 }).lean();
    const productIds = [...new Set(invoices.flatMap((invoice) =>
      invoice.products.map((item) => item.productId).filter(Boolean).map(String),
    ))];
    const products = await AquaProduct.find({ _id: { $in: productIds } }).lean();
    const productsById = new Map(products.map((product) => [String(product._id), product]));
    const now = new Date();
    const data = [];

    for (const invoice of invoices) {
      const purchaseDate = parseInvoicePurchaseDate(invoice);
      if (!purchaseDate) continue;
      for (const item of invoice.products) {
        const product = productsById.get(String(item.productId)) || {};
        const regeneration = resolveRegenerationPolicy(product, item);
        const reminders = [];
        if (regeneration) {
          reminders.push({
            type: "regeneration",
            intervalUnit: regeneration.intervalUnit,
            intervalValue: regeneration.intervalValue,
            nextDueDate: getNextDueDate(
              purchaseDate,
              regeneration.intervalUnit,
              regeneration.intervalValue,
              now,
            ),
          });
        }
        if (product?.reminderPolicy?.annualService !== false) {
          reminders.push({
            type: "annual-service",
            intervalUnit: "year",
            intervalValue: 1,
            nextDueDate: getAnnualDueDates(purchaseDate, now).next,
          });
        }
        const warranty = getWarrantyDates(purchaseDate, 12);
        reminders.push({
          type: "warranty-expiry",
          intervalUnit: "month",
          intervalValue: 12,
          reminderDate: warranty.reminderAt,
          nextDueDate: warranty.expiresAt,
          warrantyExpiresAt: warranty.expiresAt,
        });
        if (reminders.length) {
          data.push({
            invoiceId: invoice._id,
            invoiceNo: invoice.invoiceNo,
            purchaseDate,
            productId: item.productId,
            productName: item.productName || product.title || "Aquakart product",
            reminders,
          });
        }
      }
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error("Failed to list service reminders", error);
    return res.status(500).json({ success: false, message: "Failed to fetch service reminders" });
  }
};

export default { listMine };
