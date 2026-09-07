import express from "express";
import rateLimit from "express-rate-limit";
import writeExcelFile from "write-excel-file/node";
import AquaInvoice from "../models/crm/invoice.js";
import { parseReportPeriod, reportQuery, buildReportSheets } from "../services/invoiceReports.js";

// Intentionally public: month/year are the only inputs; no login or token.
export function createInvoiceReportRouter(Invoice = AquaInvoice) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    next();
  });
  router.use(rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }));
  router.get(["/:month", "/:month/:year"], async (req, res) => {
    const period = parseReportPeriod(req.params.month, req.params.year);
    if (!period) return res.status(400).json({ message: "Use a month from 1 to 12 or its full name, and a four-digit year." });
    try {
      const invoices = await Invoice.find(reportQuery(period))
        .select("_id invoiceNo date createdAt customerDetails gst po gstDetails.gstNo paymentType transport products paidStatus total_amount total")
        .sort({ date: 1, createdAt: 1, _id: 1 }).lean();
      if (!invoices.length) return res.status(404).json({ message: `No invoices for ${period.label}.` });
      const buffer = await writeExcelFile(buildReportSheets(invoices)).toBuffer();
      res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.attachment(`Aquakart_Invoices_${period.prefix}.xlsx`);
      return res.send(buffer);
    } catch (error) {
      console.error("Invoice report generation failed", { message: error.message });
      return res.status(500).json({ message: "Unable to generate the report. Please try again." });
    }
  });
  return router;
}

export default createInvoiceReportRouter();
