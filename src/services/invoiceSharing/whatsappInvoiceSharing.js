const isEnabled = () =>
  String(process.env.WHATSAPP_INVOICE_SHARING_ENABLED || "false") === "true";

export const getWhatsAppInvoiceSharingStatus = () => ({
  available: false,
  configured: isEnabled(),
  mode: "coming-soon",
  message: "WhatsApp invoice sharing will be available soon.",
});

export const shareInvoiceByWhatsApp = async () => {
  const error = new Error(
    "WhatsApp invoice sharing is not connected to a provider yet",
  );
  error.code = "WHATSAPP_PROVIDER_NOT_CONFIGURED";
  error.statusCode = 503;
  throw error;
};

export default {
  getStatus: getWhatsAppInvoiceSharingStatus,
  share: shareInvoiceByWhatsApp,
};
