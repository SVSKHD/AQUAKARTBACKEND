import {
  getFast2SmsWhatsAppConfig,
  getFast2SmsWhatsAppStatus,
  sendFast2SmsWhatsAppTemplate,
} from "../notifications/fast2SmsWhatsApp.js";

export const getWhatsAppInvoiceSharingStatus = getFast2SmsWhatsAppStatus;

export const shareInvoiceByWhatsApp = async ({
  invoice,
  phone,
  customerUrl,
  pdfUrl,
}) => {
  const config = getFast2SmsWhatsAppConfig();
  const invoiceNo =
    invoice.invoiceNo || invoice.invoice_no || String(invoice._id);
  const customerName = invoice.customerDetails?.name || "Customer";

  return sendFast2SmsWhatsAppTemplate({
    to: phone,
    messageId: config.invoiceMessageId,
    variables: [customerName, invoiceNo, customerUrl],
    mediaUrl: pdfUrl,
    documentFilename: pdfUrl ? `AquaKart-Invoice-${invoiceNo}.pdf` : undefined,
    udf: [String(invoice._id), "invoice", invoiceNo],
  });
};

export default {
  getStatus: getWhatsAppInvoiceSharingStatus,
  share: shareInvoiceByWhatsApp,
};
