import {
  getFast2SmsSmsConfig,
  getFast2SmsSmsStatus,
  sendFast2SmsDlt,
} from "../notifications/fast2SmsSms.js";

export const getSmsInvoiceSharingStatus = getFast2SmsSmsStatus;

export const shareInvoiceBySms = ({ invoice, phone, customerUrl }) => {
  const config = getFast2SmsSmsConfig();
  const invoiceNo =
    invoice.invoiceNo || invoice.invoice_no || String(invoice._id);
  const customerName = invoice.customerDetails?.name || "Customer";
  return sendFast2SmsDlt({
    to: phone,
    messageId: config.invoiceMessageId,
    variables: [customerName, invoiceNo, customerUrl],
  });
};
