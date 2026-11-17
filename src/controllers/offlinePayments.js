import {
  offlinePayments,
  preInvoices,
} from "../services/offlinePayments/index.js";
import {
  LINK_UNAVAILABLE,
  OfflinePaymentError,
  TOKEN_PATTERN,
} from "../services/offlinePayments/rules.js";

// HTTP layer for offline payment links and pre-invoices. Business rules are
// in src/services/offlinePayments; this file maps requests and errors only.
// Errors never echo tokens, phone numbers or addresses.

const send = (res, error) => {
  if (error instanceof OfflinePaymentError)
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  console.error("Offline payment request failed", {
    code: error?.code,
    message: error?.message,
  });
  return res.status(500).json({
    success: false,
    code: "SERVER_ERROR",
    message: "Something went wrong",
  });
};

const handle =
  (fn, status = 200) =>
  async (req, res) => {
    try {
      const data = await fn(req);
      return res.status(status).json({ success: true, data });
    } catch (error) {
      return send(res, error);
    }
  };

const token = (req) => {
  if (!TOKEN_PATTERN.test(String(req.params.token || "")))
    throw LINK_UNAVAILABLE();
  return req.params.token;
};

// ---- Customer (/v1/payments/offline/:token) ------------------------------
export const viewOfflinePayment = handle((req) =>
  offlinePayments.publicView(token(req)),
);
export const saveOfflineCustomer = handle((req) =>
  offlinePayments.bindCustomer(token(req), req.user, req.body || {}),
);
export const initiateOfflinePayment = handle(
  (req) => offlinePayments.initiate(token(req), req.user),
  201,
);
export const offlinePaymentStatus = handle((req) =>
  offlinePayments.status(token(req), req.user),
);

// ---- Admin: payment links -------------------------------------------------
const source = (kind) => (req) => ({
  kind,
  sourceId: req.params.id,
  actor: req.user,
});
export const createPreInvoiceLink = handle(
  (req) => offlinePayments.createLink(source("pre_invoice")(req)),
  201,
);
export const createQuotationLink = handle(
  (req) => offlinePayments.createLink(source("quotation")(req)),
  201,
);
export const revokePreInvoiceLink = handle((req) =>
  offlinePayments.revokeLink(source("pre_invoice")(req)),
);
export const revokeQuotationLink = handle((req) =>
  offlinePayments.revokeLink(source("quotation")(req)),
);
export const getPreInvoiceLink = handle((req) =>
  offlinePayments.getLinkState(source("pre_invoice")(req)),
);
export const getQuotationLink = handle((req) =>
  offlinePayments.getLinkState(source("quotation")(req)),
);

// ---- Admin: pre-invoices ---------------------------------------------------
export const createPreInvoice = handle(
  (req) => preInvoices.create(req.body || {}, req.user),
  201,
);
export const moveQuotationToPreInvoice = handle(
  (req) => preInvoices.moveFromQuotation(req.params.id, req.user),
  201,
);
export const listPreInvoices = async (req, res) => {
  try {
    const result = await preInvoices.list(req.query);
    return res.json({ success: true, ...result });
  } catch (error) {
    return send(res, error);
  }
};
export const getPreInvoice = handle((req) => preInvoices.get(req.params.id));
export const updatePreInvoice = handle((req) =>
  preInvoices.update(req.params.id, req.body || {}, req.user),
);
