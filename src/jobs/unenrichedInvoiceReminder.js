import AquaInvoice from "../models/crm/invoice.js";
import { deliverInvoiceWithSmsFallback } from "../services/invoiceSharing/invoiceDelivery.js";

const DEFAULT_BATCH_SIZE = 100;

export const runUnenrichedInvoiceReminder = async (now = new Date()) => {
  const batchSize = Math.max(
    1,
    Number(process.env.INVOICE_REMINDER_BATCH_SIZE || DEFAULT_BATCH_SIZE),
  );
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(now);
  const invoices = await AquaInvoice.find({
    $or: [
      { firebaseUid: { $exists: false } },
      { firebaseUid: null },
      { firebaseUid: "" },
    ],
    "customerDetails.phone": { $exists: true, $nin: [null, ""] },
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(batchSize)
    .lean();

  const results = [];
  for (const invoice of invoices) {
    try {
      const delivery = await deliverInvoiceWithSmsFallback({
        invoice,
        trigger: "weekly-unenriched-reminder",
        dedupePrefix: `invoice:${invoice._id}:unenriched:${day}`,
      });
      results.push({
        invoiceId: String(invoice._id),
        status: "sent",
        channel: delivery.channel,
      });
    } catch (error) {
      results.push({
        invoiceId: String(invoice._id),
        status: "failed",
        errorCode: error.code,
      });
    }
  }
  return results;
};

export const startUnenrichedInvoiceReminder = () => {
  if (String(process.env.INVOICE_REMINDER_ENABLED || "true") !== "true")
    return null;
  const hour = Math.min(
    23,
    Math.max(0, Number(process.env.INVOICE_REMINDER_HOUR_IST || 8)),
  );
  const weekday = Math.min(
    6,
    Math.max(0, Number(process.env.INVOICE_REMINDER_DAY_OF_WEEK_IST || 1)),
  );
  let timer;
  const scheduleNext = () => {
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const nextIst = new Date(istNow);
    nextIst.setUTCHours(hour, 0, 0, 0);

    let daysUntilRun = (weekday - istNow.getUTCDay() + 7) % 7;
    if (daysUntilRun === 0 && nextIst <= istNow) daysUntilRun = 7;
    nextIst.setUTCDate(nextIst.getUTCDate() + daysUntilRun);

    const delay = nextIst.getTime() - istNow.getTime();
    timer = setTimeout(async () => {
      try {
        await runUnenrichedInvoiceReminder();
      } catch (error) {
        console.error("Unenriched invoice reminder failed", error);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  scheduleNext();
  return { stop: () => clearTimeout(timer) };
};
