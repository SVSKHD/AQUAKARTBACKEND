import crypto from "node:crypto";
import AquaInvoice from "../models/crm/invoice.js";
import AquaProduct from "../models/product.js";
import ServiceReminderDelivery from "../models/serviceReminderDelivery.js";
import { sendFast2SmsWhatsAppTemplate } from "../services/notifications/fast2SmsWhatsApp.js";
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

const ADMIN_STATUSES = new Set([
  "unconfirmed", "confirmed", "service-required", "completed", "not-required", "no-response",
]);

const CUSTOMER_STATUSES = new Set(["confirmed", "service-required", "not-required"]);

const listAdmin = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const query = {};
    if (req.query.type) query.reminderType = req.query.type;
    if (req.query.deliveryStatus) query.status = req.query.deliveryStatus;
    if (req.query.confirmationStatus) query.confirmationStatus = req.query.confirmationStatus;
    if (req.query.search) {
      const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = ["customerName", "customerPhone", "invoiceNo", "productName"].map((field) => ({
        [field]: { $regex: escaped, $options: "i" },
      }));
    }
    const [items, total] = await Promise.all([
      ServiceReminderDelivery.find(query)
        .sort({ dueDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("invoiceId", "invoiceNo customerDetails")
        .lean(),
      ServiceReminderDelivery.countDocuments(query),
    ]);
    return res.json({
      success: true,
      data: items.map(({ confirmationToken, ...item }) => ({
        ...item,
        invoiceId: item.invoiceId?._id || item.invoiceId,
        invoiceNo: item.invoiceNo || item.invoiceId?.invoiceNo,
        customerName: item.customerName || item.invoiceId?.customerDetails?.name,
        customerPhone: item.customerPhone || String(item.invoiceId?.customerDetails?.phone || ""),
      })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    console.error("Failed to list reminder deliveries", error);
    return res.status(500).json({ success: false, message: "Failed to fetch reminder history" });
  }
};

const updateConfirmation = async (req, res) => {
  const status = String(req.body.status || "");
  if (!ADMIN_STATUSES.has(status)) {
    return res.status(400).json({ success: false, message: "Invalid confirmation status" });
  }
  const reminder = await ServiceReminderDelivery.findByIdAndUpdate(
    req.params.id,
    {
      confirmationStatus: status,
      confirmedAt: status === "unconfirmed" ? null : new Date(),
      confirmedBy: "staff",
      confirmationNotes: String(req.body.notes || "").trim().slice(0, 1000),
      ...(status === "confirmed" || status === "completed" ? { status: "confirmed" } : {}),
    },
    { new: true },
  ).lean();
  if (!reminder) return res.status(404).json({ success: false, message: "Reminder not found" });
  const { confirmationToken, ...safeReminder } = reminder;
  return res.json({ success: true, data: safeReminder });
};

const getPublicConfirmation = async (req, res) => {
  const reminder = await ServiceReminderDelivery.findOne({ confirmationToken: req.params.token }).lean();
  if (!reminder) return res.status(404).json({ success: false, message: "Reminder link is invalid" });
  return res.json({
    success: true,
    data: {
      productName: reminder.productName,
      reminderType: reminder.reminderType,
      dueDate: reminder.dueDate,
      confirmationStatus: reminder.confirmationStatus,
      invoiceId: reminder.invoiceId,
      invoiceNo: reminder.invoiceNo,
    },
  });
};

const confirmPublic = async (req, res) => {
  const status = String(req.body.status || "");
  if (!CUSTOMER_STATUSES.has(status)) {
    return res.status(400).json({ success: false, message: "Invalid confirmation status" });
  }
  const reminder = await ServiceReminderDelivery.findOneAndUpdate(
    { confirmationToken: req.params.token },
    {
      confirmationStatus: status,
      confirmedAt: new Date(),
      confirmedBy: "customer",
      confirmationNotes: String(req.body.notes || "").trim().slice(0, 1000),
      ...(status === "confirmed" ? { status: "confirmed" } : {}),
    },
    { new: true },
  ).lean();
  if (!reminder) return res.status(404).json({ success: false, message: "Reminder link is invalid" });
  return res.json({ success: true, data: { confirmationStatus: reminder.confirmationStatus } });
};

const resend = async (req, res) => {
  const reminder = await ServiceReminderDelivery.findById(req.params.id);
  if (!reminder) return res.status(404).json({ success: false, message: "Reminder not found" });
  if (!reminder.confirmationToken) reminder.confirmationToken = crypto.randomBytes(24).toString("hex");
  if (!reminder.customerPhone) {
    const invoice = await AquaInvoice.findById(reminder.invoiceId).select("invoiceNo customerDetails").lean();
    reminder.customerPhone = String(invoice?.customerDetails?.phone || "");
    reminder.customerName = reminder.customerName || invoice?.customerDetails?.name || "Customer";
    reminder.invoiceNo = reminder.invoiceNo || invoice?.invoiceNo;
  }
  const envNames = {
    regeneration: "FAST2SMS_WHATSAPP_REGENERATION_MESSAGE_ID",
    "annual-service": "FAST2SMS_WHATSAPP_ANNUAL_SERVICE_MESSAGE_ID",
    "warranty-expiry": "FAST2SMS_WHATSAPP_WARRANTY_EXPIRY_MESSAGE_ID",
  };
  const defaults = { regeneration: "31043", "annual-service": "31044", "warranty-expiry": "31045" };
  const frontend = (process.env.FRONTEND_PUBLIC_URL || process.env.FRONTEND_URL || "https://aquakart.co.in").replace(/\/$/, "");
  try {
    const formattedDueDate = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" }).format(reminder.dueDate);
    const confirmationLink = `${frontend}/service-reminder/confirm/${reminder.confirmationToken}`;
    const variables = reminder.reminderType === "warranty-expiry"
      ? [
          reminder.customerName || "Customer",
          reminder.productName,
          new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" }).format(reminder.purchaseDate || reminder.createdAt),
          new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" }).format(reminder.warrantyExpiresAt || reminder.dueDate),
          confirmationLink,
        ]
      : [reminder.customerName || "Customer", reminder.productName, formattedDueDate, confirmationLink];
    await sendFast2SmsWhatsAppTemplate({
      to: reminder.customerPhone,
      messageId: process.env[envNames[reminder.reminderType]] || defaults[reminder.reminderType],
      variables,
    });
    reminder.status = "sent";
    reminder.lastSentAt = new Date();
    reminder.attemptCount += 1;
    reminder.attempts.push({ status: "sent", channel: "whatsapp" });
    reminder.errorCode = undefined;
    await reminder.save();
    return res.json({ success: true, message: "Reminder resent successfully" });
  } catch (error) {
    reminder.status = "failed";
    reminder.errorCode = error.code || "REMINDER_DELIVERY_FAILED";
    reminder.attemptCount += 1;
    reminder.attempts.push({ status: "failed", errorCode: reminder.errorCode });
    await reminder.save();
    return res.status(502).json({ success: false, message: "Reminder could not be resent", code: reminder.errorCode });
  }
};

export default { listMine, listAdmin, updateConfirmation, getPublicConfirmation, confirmPublic, resend };
