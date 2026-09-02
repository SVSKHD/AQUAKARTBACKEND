import crypto from "node:crypto";
import AquaInvoice from "../models/crm/invoice.js";
import AquaProduct from "../models/product.js";
import ServiceReminderDelivery from "../models/serviceReminderDelivery.js";
import { sendFast2SmsWhatsAppTemplate } from "../services/notifications/fast2SmsWhatsApp.js";
import {
  buildReminderDedupeKey,
  getAnnualDueDates,
  getCurrentDueDate,
  getWarrantyDates,
  isDueWithinGrace,
  parseInvoicePurchaseDate,
  resolveRegenerationPolicy,
} from "../services/serviceReminders.js";

const TEMPLATE_IDS = {
  regeneration: "31043",
  "annual-service": "31044",
  "warranty-expiry": "31045",
};

const formatDate = (value) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(value);

const getConfirmationLink = (token) => {
  const frontendUrl = (
    process.env.FRONTEND_PUBLIC_URL || process.env.FRONTEND_URL || "https://aquakart.co.in"
  ).replace(/\/$/, "");
  return `${frontendUrl}/service-reminder/confirm/${token}`;
};

const getTemplateId = (type) => {
  const envNames = {
    regeneration: "FAST2SMS_WHATSAPP_REGENERATION_MESSAGE_ID",
    "annual-service": "FAST2SMS_WHATSAPP_ANNUAL_SERVICE_MESSAGE_ID",
    "warranty-expiry": "FAST2SMS_WHATSAPP_WARRANTY_EXPIRY_MESSAGE_ID",
  };
  return process.env[envNames[type]] || TEMPLATE_IDS[type];
};

const sendReminder = async ({ to, type, variables }) => {
  await sendFast2SmsWhatsAppTemplate({
    to,
    messageId: getTemplateId(type),
    variables,
  });
  return "whatsapp";
};

export const attemptDelivery = async ({ invoice, item, type, dueDate, purchaseDate, warrantyExpiresAt }) => {
  const productKey = String(item.productId || item.productSlug || item.productName);
  const dedupeKey = buildReminderDedupeKey({
    invoiceId: invoice._id,
    productKey,
    type,
    dueDate,
  });
  let delivery;
  try {
    delivery = await ServiceReminderDelivery.create({
      dedupeKey,
      invoiceId: invoice._id,
      productId: item.productId,
      productName: item.productName || "Aquakart product",
      reminderType: type,
      dueDate,
      purchaseDate,
      warrantyExpiresAt,
      customerName: invoice.customerDetails?.name || "Customer",
      customerPhone: String(invoice.customerDetails?.phone || ""),
      invoiceNo: invoice.invoiceNo,
      confirmationToken: crypto.randomBytes(24).toString("hex"),
    });
  } catch (error) {
    if (error?.code === 11000) {
      delivery = await ServiceReminderDelivery.findOne({ dedupeKey });
      if (!delivery || delivery.status !== "failed") {
        return { status: "duplicate", dedupeKey };
      }
      await ServiceReminderDelivery.findByIdAndUpdate(delivery._id, {
        status: "pending",
        ...(!delivery.confirmationToken ? { confirmationToken: crypto.randomBytes(24).toString("hex") } : {}),
        $unset: { errorCode: 1 },
      });
      delivery = await ServiceReminderDelivery.findById(delivery._id);
    } else {
      throw error;
    }
  }

  try {
    const customerName = invoice.customerDetails?.name || "Customer";
    const productName = item.productName || "Aquakart product";
    const invoiceLink = getConfirmationLink(delivery.confirmationToken);
    const variables = type === "warranty-expiry"
      ? [
          customerName,
          productName,
          formatDate(purchaseDate),
          formatDate(warrantyExpiresAt),
          invoiceLink,
        ]
      : [customerName, productName, formatDate(dueDate), invoiceLink];
    const channel = await sendReminder({
      to: invoice.customerDetails?.phone,
      type,
      variables,
    });
    await ServiceReminderDelivery.findByIdAndUpdate(delivery._id, {
      status: "sent",
      channel,
      lastSentAt: new Date(),
      $inc: { attemptCount: 1 },
      $push: { attempts: { status: "sent", channel } },
    });
    return { status: "sent", channel, dedupeKey };
  } catch (error) {
    await ServiceReminderDelivery.findByIdAndUpdate(delivery._id, {
      status: "failed",
      errorCode: error.code || "REMINDER_DELIVERY_FAILED",
      $inc: { attemptCount: 1 },
      $push: { attempts: { status: "failed", errorCode: error.code || "REMINDER_DELIVERY_FAILED" } },
    });
    return { status: "failed", errorCode: error.code, dedupeKey };
  }
};

export const runProductServiceReminders = async (now = new Date()) => {
  const invoices = await AquaInvoice.find({
    quotation: { $ne: true },
    "customerDetails.phone": { $exists: true, $nin: [null, ""] },
    "products.0": { $exists: true },
  }).lean();
  const productIds = [...new Set(invoices.flatMap((invoice) =>
    invoice.products.map((item) => item.productId).filter(Boolean).map(String),
  ))];
  const products = await AquaProduct.find({ _id: { $in: productIds } }).lean();
  const productsById = new Map(products.map((product) => [String(product._id), product]));
  const results = [];

  for (const invoice of invoices) {
    const purchaseDate = parseInvoicePurchaseDate(invoice);
    if (!purchaseDate) continue;
    for (const item of invoice.products) {
      const product = productsById.get(String(item.productId)) || {};
      const regeneration = resolveRegenerationPolicy(product, item);
      if (regeneration) {
        const dueDate = getCurrentDueDate(
          purchaseDate,
          regeneration.intervalUnit,
          regeneration.intervalValue,
          now,
        );
        if (isDueWithinGrace(dueDate, now)) {
          results.push(await attemptDelivery({ invoice, item, type: "regeneration", dueDate }));
        }
      }
      if (product?.reminderPolicy?.annualService !== false) {
        const { current: dueDate } = getAnnualDueDates(purchaseDate, now);
        if (isDueWithinGrace(dueDate, now)) {
          results.push(await attemptDelivery({ invoice, item, type: "annual-service", dueDate, purchaseDate }));
        }
      }
      const warranty = getWarrantyDates(purchaseDate, 12);
      if (isDueWithinGrace(warranty.reminderAt, now)) {
        results.push(await attemptDelivery({
          invoice,
          item,
          type: "warranty-expiry",
          dueDate: warranty.reminderAt,
          purchaseDate,
          warrantyExpiresAt: warranty.expiresAt,
        }));
      }
    }
  }
  return results;
};

export const startProductServiceReminders = () => {
  if (String(process.env.PRODUCT_SERVICE_REMINDERS_ENABLED || "true") !== "true") return null;
  const hour = Math.min(23, Math.max(0, Number(process.env.PRODUCT_SERVICE_REMINDERS_HOUR_IST || 9)));
  let timer;
  const scheduleNext = () => {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const nextIst = new Date(istNow);
    nextIst.setUTCHours(hour, 0, 0, 0);
    if (nextIst <= istNow) nextIst.setUTCDate(nextIst.getUTCDate() + 1);
    timer = setTimeout(async () => {
      try { await runProductServiceReminders(); }
      catch (error) { console.error("Product service reminder job failed", error); }
      finally { scheduleNext(); }
    }, nextIst.getTime() - istNow.getTime());
  };
  scheduleNext();
  return { stop: () => clearTimeout(timer) };
};
