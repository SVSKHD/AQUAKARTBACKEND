import {
  createPhonePePayment,
  phonePeMerchantId,
  verifyPhonePePayment,
} from "../gateways/phonepe.js";
import { writeAudit } from "../audit.js";
import {
  assertInvoiceStock,
  persistInvoice,
  validateInvoicePayload,
} from "../../controllers/crm/invoice.js";
import { mongoOfflinePaymentStore } from "./mongoStore.js";
import { createOfflinePaymentService } from "./service.js";
import { createPreInvoiceService } from "./preInvoices.js";

// Production wiring for offline payment links and pre-invoices.

const httpsOrigin = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    return url.protocol === "https:" || (local && url.protocol === "http:")
      ? url.origin
      : null;
  } catch (_error) {
    return null;
  }
};
const bounded = (value, fallback, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
};

export const loadOfflinePaymentConfig = (env = process.env) => ({
  publicBaseUrl:
    httpsOrigin(env.OFFLINE_PAYMENT_PUBLIC_BASE_URL) ||
    httpsOrigin(env.ECOM_BASE_URL) ||
    "https://aquakart.co.in",
  linkTtlHours: bounded(env.OFFLINE_PAYMENT_LINK_TTL_HOURS, 72, 24 * 30),
  attemptTtlMinutes: bounded(env.OFFLINE_PAYMENT_ATTEMPT_TTL_MINUTES, 15, 120),
});

const audit = ({ action, adminUserId, resourceType, resourceId, metadata }) =>
  writeAudit({
    req: adminUserId ? { user: { _id: adminUserId } } : undefined,
    action,
    resourceType,
    resourceId,
    metadata,
  });

export const offlinePayments = createOfflinePaymentService({
  store: mongoOfflinePaymentStore,
  gateway: {
    create: createPhonePePayment,
    verify: verifyPhonePePayment,
    merchantId: phonePeMerchantId,
  },
  invoiceWriter: {
    validate: (payload) => validateInvoicePayload(payload),
    persist: (payload) => persistInvoice(payload),
    assertStock: (products) => assertInvoiceStock(products),
  },
  config: loadOfflinePaymentConfig(),
  audit,
});

export const preInvoices = createPreInvoiceService({
  store: mongoOfflinePaymentStore,
  payments: offlinePayments,
  audit,
});
