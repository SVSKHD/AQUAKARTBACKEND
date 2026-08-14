import AquaInvoice from "../../models/crm/invoice.js";
import NotificationLog from "../../models/crm/notificationLog.js";
import AquaEcomUser from "../../models/user.js";
import { shareInvoiceByWhatsApp } from "../../services/invoiceSharing/whatsappInvoiceSharing.js";
import {
  normalizeEmail,
  normalizeIndianPhone,
} from "../../utils/invoiceAccess.js";
import { buildInvoiceViewLinks } from "../../utils/invoiceViews.js";

const BACKFILL_TEMPLATE = "fast2sms-invoice-backfill";
const DELIVERY_TEMPLATE = "fast2sms-invoice";
const MAX_BATCH_SIZE = 20;
const DEFAULT_BATCH_SIZE = 10;
const CONFIRMATION = "SEND_HISTORICAL_INVOICES";

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const getProviderMessageId = (delivery = {}) =>
  delivery?.data?.message_id ||
  delivery?.data?.request_id ||
  delivery?.data?.data?.message_id ||
  undefined;

const getProcessedInvoiceIds = async () => {
  const [sentIds, backfillIds] = await Promise.all([
    NotificationLog.distinct("invoiceId", {
      channel: "whatsapp",
      template: DELIVERY_TEMPLATE,
      status: "sent",
      invoiceId: { $ne: null },
    }),
    NotificationLog.distinct("invoiceId", {
      channel: "whatsapp",
      template: BACKFILL_TEMPLATE,
      invoiceId: { $ne: null },
    }),
  ]);

  return [...new Set([...sentIds, ...backfillIds].map(String))];
};

const getEligibleQuery = (processedIds = []) => ({
  ...(processedIds.length ? { _id: { $nin: processedIds } } : {}),
  "customerDetails.phone": { $exists: true, $nin: [null, ""] },
});

const enrichLegacyInvoice = async (invoice) => {
  const phone = normalizeIndianPhone(invoice?.customerDetails?.phone);
  const email = normalizeEmail(invoice?.customerDetails?.email);
  const normalizedFields = {
    customerPhoneNormalized: phone,
    customerEmailNormalized: email,
  };

  await AquaInvoice.updateOne(
    { _id: invoice._id },
    { $set: normalizedFields },
  );

  const identity = [];
  if (email) identity.push({ email });
  if (phone) identity.push({ phone: Number(phone) });

  let customerLinked = false;
  if (identity.length) {
    const result = await AquaEcomUser.updateOne(
      { $or: identity },
      {
        $addToSet: {
          invoices: {
            invoiceId: invoice._id,
            invoiceNo: String(invoice.invoiceNo || "").trim(),
          },
        },
        $set: { invoiceProfileEnrichedAt: new Date() },
      },
    );
    customerLinked = result.matchedCount > 0;
  }

  return { phone, email, customerLinked };
};

const createBackfillLog = async ({ invoice, phone, status, errorCode }) => {
  try {
    return await NotificationLog.create({
      invoiceId: invoice._id,
      phone,
      channel: "whatsapp",
      message: `Historical Fast2SMS invoice template ${invoice.invoiceNo || invoice._id}`,
      status,
      template: BACKFILL_TEMPLATE,
      dedupeKey: `invoice:${invoice._id}:whatsapp:historical-backfill`,
      errorCode,
      response: { trigger: "historical-backfill" },
    });
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
};

const previewHistoricalInvoiceBackfill = async (_req, res) => {
  try {
    const processedIds = await getProcessedInvoiceIds();
    const query = getEligibleQuery(processedIds);
    const [eligibleCount, sample] = await Promise.all([
      AquaInvoice.countDocuments(query),
      AquaInvoice.find(query)
        .sort({ createdAt: 1, _id: 1 })
        .limit(10)
        .select("_id invoiceNo date customerDetails")
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      dryRun: true,
      eligibleCount,
      processedCount: processedIds.length,
      maxBatchSize: MAX_BATCH_SIZE,
      sample: sample.map((invoice) => ({
        invoiceId: String(invoice._id),
        invoiceNo: invoice.invoiceNo || "",
        date: invoice.date || "",
        customerName: invoice.customerDetails?.name || "Customer",
        phone: normalizeIndianPhone(invoice.customerDetails?.phone),
        hasEmail: Boolean(normalizeEmail(invoice.customerDetails?.email)),
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to preview historical invoice delivery",
    });
  }
};

const runHistoricalInvoiceBackfill = async (req, res) => {
  if (req.body?.confirmation !== CONFIRMATION) {
    return res.status(400).json({
      success: false,
      message: `confirmation must equal ${CONFIRMATION}`,
    });
  }

  const requestedSize = Number(req.body?.batchSize || DEFAULT_BATCH_SIZE);
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Number.isFinite(requestedSize) ? requestedSize : DEFAULT_BATCH_SIZE),
  );
  const delayMs = Math.min(
    2_000,
    Math.max(0, Number(process.env.INVOICE_BACKFILL_DELAY_MS || 300)),
  );

  try {
    const processedIds = await getProcessedInvoiceIds();
    const invoices = await AquaInvoice.find(getEligibleQuery(processedIds))
      .sort({ createdAt: 1, _id: 1 })
      .limit(batchSize)
      .lean();

    const results = [];
    for (const invoice of invoices) {
      let enriched;
      try {
        enriched = await enrichLegacyInvoice(invoice);
      } catch (error) {
        results.push({
          invoiceId: String(invoice._id),
          invoiceNo: invoice.invoiceNo || "",
          status: "failed",
          stage: "enrichment",
          errorCode: "INVOICE_ENRICHMENT_FAILED",
        });
        continue;
      }

      if (!/^[6-9]\d{9}$/.test(enriched.phone || "")) {
        await createBackfillLog({
          invoice,
          phone: enriched.phone,
          status: "failed",
          errorCode: "INVOICE_PHONE_INVALID",
        });
        results.push({
          invoiceId: String(invoice._id),
          invoiceNo: invoice.invoiceNo || "",
          status: "skipped",
          reason: "invalid-phone",
          enriched: true,
          customerLinked: enriched.customerLinked,
        });
        continue;
      }

      const notification = await createBackfillLog({
        invoice,
        phone: enriched.phone,
        status: "pending",
      });
      if (!notification) {
        results.push({
          invoiceId: String(invoice._id),
          invoiceNo: invoice.invoiceNo || "",
          status: "skipped",
          reason: "already-processed",
        });
        continue;
      }

      try {
        const customerUrl = buildInvoiceViewLinks(
          invoice._id,
          invoice,
        ).customerUrl;
        const delivery = await shareInvoiceByWhatsApp({
          invoice,
          phone: enriched.phone,
          customerUrl,
        });

        notification.status = "sent";
        notification.providerMessageId = getProviderMessageId(delivery);
        notification.response = {
          trigger: "historical-backfill",
          delivery,
          customerLinked: enriched.customerLinked,
        };
        await notification.save();

        results.push({
          invoiceId: String(invoice._id),
          invoiceNo: invoice.invoiceNo || "",
          status: "sent",
          enriched: true,
          customerLinked: enriched.customerLinked,
        });
      } catch (error) {
        notification.status = "failed";
        notification.errorCode =
          error?.code || "WHATSAPP_DELIVERY_FAILED";
        notification.response = {
          trigger: "historical-backfill",
          error: error?.details || error?.message || "WhatsApp delivery failed",
          customerLinked: enriched.customerLinked,
        };
        await notification.save();

        results.push({
          invoiceId: String(invoice._id),
          invoiceNo: invoice.invoiceNo || "",
          status: "failed",
          stage: "delivery",
          errorCode: notification.errorCode,
          enriched: true,
          customerLinked: enriched.customerLinked,
        });
      }

      if (delayMs) await pause(delayMs);
    }

    const latestProcessedIds = await getProcessedInvoiceIds();
    const remainingCount = await AquaInvoice.countDocuments(
      getEligibleQuery(latestProcessedIds),
    );

    const summary = results.reduce(
      (totals, result) => {
        totals[result.status] += 1;
        if (result.enriched) totals.enriched += 1;
        if (result.customerLinked) totals.customersLinked += 1;
        return totals;
      },
      { sent: 0, skipped: 0, failed: 0, enriched: 0, customersLinked: 0 },
    );

    return res.status(200).json({
      success: true,
      batchSize: invoices.length,
      remainingCount,
      hasMore: remainingCount > 0,
      summary,
      results,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Historical invoice delivery batch failed",
    });
  }
};

export default {
  previewHistoricalInvoiceBackfill,
  runHistoricalInvoiceBackfill,
};
