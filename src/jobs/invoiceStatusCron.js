import cron from "node-cron";
import AquaInvoice from "../models/crm/invoice.js";
import NotificationLog from "../models/crm/notificationLog.js";
import sendWhatsAppMessage from "../notifications/phone/sendWhatsapp.js";

// Ensure the related product model is registered before populate runs.
import "../models/product.js";

const ADMIN_PHONE = process.env.INVOICE_STATUS_CRON_PHONE || "9014774667";
const SCHEDULE = process.env.INVOICE_STATUS_CRON_SCHEDULE || "*/15 * * * *";
const CRON_ENABLED =
  (process.env.INVOICE_STATUS_CRON_ENABLED || "true").toLowerCase() === "true";

let task = null;
let running = false;

const formatInvoiceLine = (invoice) => {
  const status = invoice.paidStatus || "pending";
  const productTitle =
    invoice.productId?.title ||
    invoice.products?.[0]?.productName ||
    "N/A";
  return `• ${invoice.invoiceNo || invoice._id} (id: ${invoice._id}) — ${productTitle} — status: ${status}`;
};

const buildMessage = (invoices) =>
  [
    `Aquakart Invoice Status Update (${invoices.length} new):`,
    ...invoices.map(formatInvoiceLine),
  ].join("\n");

const runInvoiceStatusJob = async () => {
  if (running) {
    console.log(
      "[invoiceStatusCron] Previous run still in progress, skipping tick",
    );
    return;
  }
  running = true;
  try {
    const invoices = await AquaInvoice.find({
      cronStatusNotified: { $ne: true },
    })
      .populate("productId")
      .sort({ createdAt: -1 })
      .lean();

    if (!invoices.length) {
      console.log("[invoiceStatusCron] No new invoices to notify");
      return;
    }

    const message = buildMessage(invoices);
    let delivery;
    let deliverySucceeded = false;
    try {
      delivery = await sendWhatsAppMessage(ADMIN_PHONE, message);
      deliverySucceeded = Boolean(delivery?.status);
    } catch (err) {
      delivery = err;
      deliverySucceeded = false;
    }

    const status = deliverySucceeded ? "sent" : "failed";

    await NotificationLog.create({
      phone: ADMIN_PHONE,
      message,
      status,
      response: delivery,
    });

    if (deliverySucceeded) {
      const ids = invoices.map((invoice) => invoice._id);
      await AquaInvoice.updateMany(
        { _id: { $in: ids } },
        {
          $set: {
            cronStatusNotified: true,
            cronStatusNotifiedAt: new Date(),
          },
        },
      );
    }

    console.log(
      `[invoiceStatusCron] Notified ${ADMIN_PHONE} about ${invoices.length} invoices: ${status}`,
    );
  } catch (error) {
    console.error("[invoiceStatusCron] Error running job:", error);
  } finally {
    running = false;
  }
};

const startInvoiceStatusCron = () => {
  if (!CRON_ENABLED) {
    console.log(
      "[invoiceStatusCron] Disabled via INVOICE_STATUS_CRON_ENABLED",
    );
    return null;
  }
  if (task) return task;
  if (!cron.validate(SCHEDULE)) {
    console.error(
      `[invoiceStatusCron] Invalid schedule "${SCHEDULE}", cron not started`,
    );
    return null;
  }
  task = cron.schedule(SCHEDULE, runInvoiceStatusJob, { scheduled: true });
  console.log(
    `[invoiceStatusCron] Scheduled "${SCHEDULE}" → WhatsApp ${ADMIN_PHONE}`,
  );
  // Fire once on enable so the admin gets the current status immediately.
  runInvoiceStatusJob().catch((err) =>
    console.error("[invoiceStatusCron] Initial run failed:", err),
  );
  return task;
};

const stopInvoiceStatusCron = () => {
  if (task) {
    task.stop();
    task = null;
  }
};

export { startInvoiceStatusCron, stopInvoiceStatusCron, runInvoiceStatusJob };
