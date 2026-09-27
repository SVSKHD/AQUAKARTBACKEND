export const sanitizeInvoiceFilePart = (value) =>
  String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

export const getInvoicePdfFileName = (reference) => {
  const safeReference = sanitizeInvoiceFilePart(reference);
  return safeReference
    ? `Aquakart-Invoice-${safeReference}.pdf`
    : "Aquakart-Invoice.pdf";
};

export default getInvoicePdfFileName;
