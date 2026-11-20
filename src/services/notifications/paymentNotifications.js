import NotificationLog from "../../models/crm/notificationLog.js";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";
import { buildInvoiceViewLinks } from "../../utils/invoiceViews.js";
import {
  getFast2SmsWhatsAppConfig,
  sendFast2SmsWhatsAppTemplate,
} from "./fast2SmsWhatsApp.js";
import { getFast2SmsSmsConfig, sendFast2SmsDlt } from "./fast2SmsSms.js";

// Payment-success notifications (docs/PAYMENT_NOTIFICATIONS.md).
//
//   adminOrderAlert   -> ORDER_ALERT_PHONES (default 9014774667)
//   orderConfirmed    -> storefront customer, with the order link
//   paymentReceived   -> payment-link customer, with the invoice link
//
// Each event uses an approved Fast2SMS WhatsApp template, falling back to an
// approved DLT SMS template. Template IDs come from the environment; an event
// with neither configured is skipped. Every send is deduplicated through
// NotificationLog.dedupeKey, so webhook retries and reconciles never send a
// message twice; a failed send may be retried by a later call.
//
// Callers fire these without awaiting the provider in the payment path, and
// nothing here throws: a notification problem never fails a payment.

const DEFAULT_ADMIN_PHONES = "9014774667";
const SMS_VARIABLE_MAX = 30; // DLT limit per {#var#}

export const PAYMENT_TEMPLATES = {
  adminOrderAlert: {
    whatsappEnv: "FAST2SMS_WHATSAPP_ADMIN_ORDER_MESSAGE_ID",
    smsEnv: "FAST2SMS_SMS_ADMIN_ORDER_MESSAGE_ID",
  },
  orderConfirmed: {
    whatsappEnv: "FAST2SMS_WHATSAPP_ORDER_CONFIRMED_MESSAGE_ID",
    smsEnv: "FAST2SMS_SMS_ORDER_CONFIRMED_MESSAGE_ID",
  },
  paymentReceived: {
    whatsappEnv: "FAST2SMS_WHATSAPP_PAYMENT_RECEIVED_MESSAGE_ID",
    smsEnv: "FAST2SMS_SMS_PAYMENT_RECEIVED_MESSAGE_ID",
  },
  // WhatsApp only: the 43-character /pay/{token} cannot fit a 30-character
  // DLT variable, so there is no SMS version.
  paymentLinkRequest: {
    whatsappEnv: "FAST2SMS_WHATSAPP_PAYMENT_LINK_MESSAGE_ID",
    smsEnv: null,
  },
};

export const getAdminAlertPhones = (env = process.env) => [
  ...new Set(
    String(env.ORDER_ALERT_PHONES ?? DEFAULT_ADMIN_PHONES)
      .split(",")
      .map((value) => normalizeIndianPhone(value))
      .filter(Boolean),
  ),
];

const channelsFor = (event, env = process.env) => {
  const template = PAYMENT_TEMPLATES[event];
  const whatsapp = getFast2SmsWhatsAppConfig();
  const sms = getFast2SmsSmsConfig();
  const whatsappId = env[template.whatsappEnv] || "";
  const smsId = (template.smsEnv && env[template.smsEnv]) || "";
  return {
    whatsapp:
      whatsappId && whatsapp.apiKey && whatsapp.phoneNumberId
        ? whatsappId
        : null,
    sms: smsId && sms.enabled && sms.apiKey && sms.senderId ? smsId : null,
  };
};

export const isPaymentTemplateConfigured = (event, env = process.env) => {
  const channels = channelsFor(event, env);
  return Boolean(channels.whatsapp || channels.sms);
};

export const getPaymentNotificationStatus = (env = process.env) => ({
  adminPhones: getAdminAlertPhones(env).length,
  events: Object.fromEntries(
    Object.entries(PAYMENT_TEMPLATES).map(([event, template]) => {
      const channels = channelsFor(event, env);
      return [
        event,
        {
          whatsapp: Boolean(channels.whatsapp),
          sms: Boolean(channels.sms),
          env: [template.whatsappEnv, template.smsEnv].filter(Boolean),
        },
      ];
    }),
  ),
});

export const formatAmount = (value) =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);

// e.g. "23 Nov 2026, 10:30 am" in India time.
export const formatExpiry = (value) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));

const smsValue = (value) => String(value ?? "").slice(0, SMS_VARIABLE_MAX);

const orderUrl = (transactionId) =>
  `${(process.env.ECOM_BASE_URL || "https://aquakart.co.in").replace(/\/$/, "")}/order/${encodeURIComponent(transactionId)}`;

const defaultDeps = {
  logs: {
    create: (doc) => NotificationLog.create(doc),
    findOne: (query) => NotificationLog.findOne(query).lean(),
    reclaimFailed: (dedupeKey) =>
      NotificationLog.findOneAndUpdate(
        { dedupeKey, status: "failed" },
        { $set: { status: "pending", errorCode: null } },
        { new: true },
      ),
    update: (id, set) => NotificationLog.updateOne({ _id: id }, { $set: set }),
  },
  sendWhatsApp: sendFast2SmsWhatsAppTemplate,
  sendSms: sendFast2SmsDlt,
  log: console,
};

// Claim the dedupe key: a new log, or a previously failed one. Returns null
// when the message was already sent or is being sent.
const claim = async (logs, doc) => {
  try {
    return await logs.create(doc);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return logs.reclaimFailed(doc.dedupeKey);
  }
};

// Sends one event to one phone: WhatsApp first, SMS if WhatsApp fails or is
// not configured. Resolves to a result; never throws.
export const sendPaymentTemplate = async (
  {
    event,
    to,
    whatsappVariables,
    smsVariables,
    dedupeKey,
    reference,
    invoiceId,
  },
  deps = defaultDeps,
) => {
  const phone = normalizeIndianPhone(to);
  if (!phone) return { sent: false, skipped: "INVALID_PHONE", event };
  const channels = channelsFor(event);
  if (!channels.whatsapp && !channels.sms)
    return { sent: false, skipped: "NOT_CONFIGURED", event };

  let entry;
  try {
    entry = await claim(deps.logs, {
      event,
      reference,
      invoiceId,
      phone,
      channel: channels.whatsapp ? "whatsapp" : "sms",
      template: event,
      message: `${event} ${reference || ""}`.trim(),
      status: "pending",
      dedupeKey,
    });
  } catch (error) {
    deps.log.error("Payment notification log failed", {
      event,
      code: error?.code,
    });
    return { sent: false, skipped: "LOG_FAILED", event };
  }
  if (!entry) return { sent: false, duplicate: true, event };

  const errors = [];
  const tries = [
    channels.whatsapp && {
      channel: "whatsapp",
      send: () =>
        deps.sendWhatsApp({
          to: phone,
          messageId: channels.whatsapp,
          variables: whatsappVariables,
          udf: [reference, event],
        }),
    },
    channels.sms && {
      channel: "sms",
      send: () =>
        deps.sendSms({
          to: phone,
          messageId: channels.sms,
          variables: smsVariables.map(smsValue),
        }),
    },
  ].filter(Boolean);

  for (const { channel, send } of tries) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const delivery = await send();
      // eslint-disable-next-line no-await-in-loop
      await deps.logs.update(entry._id, {
        status: "sent",
        channel,
        providerMessageId:
          delivery?.data?.message_id || delivery?.data?.request_id,
        response: { delivery, errors },
      });
      return { sent: true, channel, event, fallback: errors.length > 0 };
    } catch (error) {
      errors.push({ channel, code: error?.code, message: error?.message });
    }
  }
  await deps.logs.update(entry._id, {
    status: "failed",
    errorCode: errors.at(-1)?.code || "PAYMENT_NOTIFICATION_FAILED",
    response: { errors },
  });
  deps.log.error("Payment notification failed", { event, reference, errors });
  return { sent: false, event, errors };
};

const alertAdmins = (
  { kind, reference, dedupeBase, customerName, customerPhone, amount },
  deps,
) => {
  const variables = [
    kind,
    reference,
    customerName || "Customer",
    customerPhone || "-",
    formatAmount(amount),
  ];
  return Promise.all(
    getAdminAlertPhones().map((phone) =>
      sendPaymentTemplate(
        {
          event: "adminOrderAlert",
          to: phone,
          whatsappVariables: variables,
          smsVariables: variables,
          dedupeKey: `${dedupeBase}:admin-alert:${phone}`,
          reference,
        },
        deps,
      ),
    ),
  );
};

const customerName = (user = {}) =>
  [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
  user.name ||
  "Customer";

// Storefront order (new checkout or legacy PhonePe) is newly paid.
// order: AquaOrder doc/object; user: AquaEcomUser (may be null).
export const notifyStorefrontOrderPaid = async (
  { order, user },
  deps = defaultDeps,
) => {
  const reference = order.orderId || String(order._id);
  const name = customerName(user || {});
  const phone =
    normalizeIndianPhone(user?.phone) ||
    normalizeIndianPhone(user?.alternatePhone);
  const amount = formatAmount(order.totalAmount);
  const [admin, customer] = await Promise.all([
    alertAdmins(
      {
        kind: "Website order",
        reference,
        dedupeBase: `order:${order._id}`,
        customerName: name,
        customerPhone: phone,
        amount: order.totalAmount,
      },
      deps,
    ),
    phone && order.transactionId
      ? sendPaymentTemplate(
          {
            event: "orderConfirmed",
            to: phone,
            whatsappVariables: [
              name,
              reference,
              amount,
              orderUrl(order.transactionId),
            ],
            smsVariables: [name, reference, amount, order.transactionId],
            dedupeKey: `order:${order._id}:order-confirmed`,
            reference,
          },
          deps,
        )
      : { sent: false, skipped: "NO_CUSTOMER_PHONE" },
  ]);
  return { admin, customer };
};

// Staff created (or regenerated) a payment link: send the customer the link.
// One message per link id; a regenerated link is a new link and is sent again.
export const notifyPaymentLinkCreated = (
  { link, doc, url, dedupeKey },
  deps = defaultDeps,
) => {
  const reference = link.source?.number || String(link._id);
  return sendPaymentTemplate(
    {
      event: "paymentLinkRequest",
      to:
        link.phoneNormalized ||
        normalizeIndianPhone(doc?.customerDetails?.phone),
      whatsappVariables: [
        doc?.customerDetails?.name || "Customer",
        reference,
        formatAmount(link.amount),
        url,
        formatExpiry(link.expiresAt),
      ],
      smsVariables: [],
      // Default: once per link (auto-send). CRM "Send" passes its own key.
      dedupeKey: dedupeKey || `payment-link:${link._id}:link-request`,
      reference,
    },
    deps,
  );
};

// Payment link is newly paid (before the invoice exists, so the admin hears
// about it even if conversion is blocked on stock).
export const notifyPaymentLinkPaid = ({ link, doc }, deps = defaultDeps) =>
  alertAdmins(
    {
      kind: "Payment link",
      reference: link.source?.number || String(link._id),
      dedupeBase: `payment-link:${link._id}`,
      customerName: doc?.customerDetails?.name,
      customerPhone:
        normalizeIndianPhone(doc?.customerDetails?.phone) ||
        link.phoneNormalized,
      amount: link.amountPaid ?? link.amount,
    },
    deps,
  );

// Payment link's invoice is created: payment receipt + invoice link to the
// customer. When this template is configured, persistInvoice skips its own
// generic invoice message (see offlinePayments/index.js); if this send then
// fails, `fallback` delivers the generic invoice template instead.
export const notifyPaymentLinkInvoiceReady = async (
  { link, invoice, fallback },
  deps = defaultDeps,
) => {
  if (!isPaymentTemplateConfigured("paymentReceived"))
    return { sent: false, skipped: "NOT_CONFIGURED" };
  const phone =
    normalizeIndianPhone(invoice.customerDetails?.phone) ||
    link.phoneNormalized;
  const name = invoice.customerDetails?.name || "Customer";
  const amount = formatAmount(link.amountPaid ?? link.amount);
  const documentNo = link.source?.number || "";
  const invoiceNo = invoice.invoiceNo || String(invoice._id);
  const result = await sendPaymentTemplate(
    {
      event: "paymentReceived",
      to: phone,
      whatsappVariables: [
        name,
        amount,
        documentNo,
        invoiceNo,
        buildInvoiceViewLinks(invoice._id, invoice).customerUrl,
      ],
      smsVariables: [name, amount, invoiceNo, String(invoice._id)],
      dedupeKey: `invoice:${invoice._id}:payment-received`,
      reference: invoiceNo,
      invoiceId: invoice._id,
    },
    deps,
  );
  if (!result.sent && !result.duplicate && fallback) {
    try {
      await fallback();
      return { ...result, fallback: "invoice-template" };
    } catch (error) {
      deps.log.error("Invoice template fallback failed", {
        invoiceId: String(invoice._id),
        code: error?.code,
      });
    }
  }
  return result;
};

// Runs a notification without blocking or failing the caller.
export const fireAndForget = (label, task, log = console) => {
  Promise.resolve()
    .then(task)
    .catch((error) =>
      log.error(`${label} notification failed`, {
        code: error?.code,
        message: error?.message,
      }),
    );
};
