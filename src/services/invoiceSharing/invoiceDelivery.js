import NotificationLog from "../../models/crm/notificationLog.js";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";
import { buildInvoiceViewLinks } from "../../utils/invoiceViews.js";
import { shareInvoiceBySms } from "./smsInvoiceSharing.js";
import { shareInvoiceByWhatsApp } from "./whatsappInvoiceSharing.js";

const providerMessageId = (delivery = {}) =>
  delivery?.data?.message_id ||
  delivery?.data?.request_id ||
  delivery?.data?.data?.message_id;

const attempt = async ({ invoice, channel, trigger, dedupeKey, send }) => {
  let log;
  try {
    log = await NotificationLog.create({
      invoiceId: invoice._id,
      phone: normalizeIndianPhone(invoice.customerDetails?.phone),
      channel,
      template: channel === "sms" ? "fast2sms-sms-invoice" : "fast2sms-invoice",
      message: `${channel.toUpperCase()} invoice ${invoice.invoiceNo || invoice._id}`,
      status: "pending",
      dedupeKey,
      response: { trigger },
    });
  } catch (error) {
    if (dedupeKey && error?.code === 11000) {
      const existing = await NotificationLog.findOne({ dedupeKey }).lean();
      if (existing?.status === "sent")
        return { success: true, duplicate: true, channel };
      const duplicateError = new Error(
        existing?.status === "pending"
          ? `${channel} delivery is already in progress`
          : `${channel} delivery previously failed`,
      );
      duplicateError.code =
        existing?.errorCode || `${channel.toUpperCase()}_DELIVERY_NOT_SENT`;
      throw duplicateError;
    }
    throw error;
  }

  try {
    const delivery = await send();
    log.status = "sent";
    log.providerMessageId = providerMessageId(delivery);
    log.response = { trigger, delivery };
    await log.save();
    return delivery;
  } catch (error) {
    log.status = "failed";
    log.errorCode = error?.code || `${channel.toUpperCase()}_DELIVERY_FAILED`;
    log.response = { trigger, error: error?.details || error?.message };
    await log.save();
    throw error;
  }
};

export const deliverInvoiceWithSmsFallback = async ({
  invoice,
  trigger = "manual",
  dedupePrefix,
  pdfUrl,
}) => {
  const phone = normalizeIndianPhone(invoice.customerDetails?.phone);
  if (!/^[6-9]\d{9}$/.test(phone)) {
    const error = new Error("Invoice has no valid customer phone");
    error.code = "INVOICE_PHONE_REQUIRED";
    error.statusCode = 400;
    throw error;
  }
  const customerUrl = buildInvoiceViewLinks(invoice._id, invoice).customerUrl;
  try {
    const whatsapp = await attempt({
      invoice,
      channel: "whatsapp",
      trigger,
      dedupeKey: dedupePrefix ? `${dedupePrefix}:whatsapp` : undefined,
      send: () =>
        shareInvoiceByWhatsApp({ invoice, phone, customerUrl, pdfUrl }),
    });
    return { success: true, channel: "whatsapp", whatsapp };
  } catch (whatsappError) {
    const sms = await attempt({
      invoice,
      channel: "sms",
      trigger: `${trigger}:whatsapp-fallback`,
      dedupeKey: dedupePrefix ? `${dedupePrefix}:sms` : undefined,
      send: () => shareInvoiceBySms({ invoice, phone, customerUrl }),
    });
    return {
      success: true,
      channel: "sms",
      fallback: true,
      sms,
      whatsappError: whatsappError.code,
    };
  }
};
