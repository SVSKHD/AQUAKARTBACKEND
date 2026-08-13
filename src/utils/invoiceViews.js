const CUSTOMER_ORIGIN = (
  process.env.INVOICE_CUSTOMER_ORIGIN || "https://aquakart.co.in"
).replace(/\/$/, "");
const ADMIN_ORIGIN = (
  process.env.INVOICE_ADMIN_ORIGIN || "https://admin.aquakart.co.in"
).replace(/\/$/, "");

const DOCUMENT_TYPES = new Set(["invoice", "quotation", "po"]);

export const buildDocumentViewLinks = (documentType, documentId) => {
  const type = String(documentType || "").trim().toLowerCase();
  const id = String(documentId || "").trim();

  if (!DOCUMENT_TYPES.has(type)) throw new Error("Unsupported document type");
  if (!id) throw new Error("Document ID is required");

  const encodedId = encodeURIComponent(id);
  const adminSection = type === "po" ? "invoice" : type;

  return {
    documentId: id,
    documentType: type,
    adminUrl: `${ADMIN_ORIGIN}/admin/${adminSection}/${encodedId}`,
    customerUrl: `${CUSTOMER_ORIGIN}/${type}/${encodedId}`,
  };
};

export const getInvoiceDocumentType = (invoice = {}) =>
  invoice.po === true ? "po" : "invoice";

export const buildInvoiceViewLinks = (invoiceId, invoice = {}) => {
  const links = buildDocumentViewLinks(getInvoiceDocumentType(invoice), invoiceId);
  return { ...links, invoiceId: links.documentId };
};

export const buildQuotationViewLinks = (quotationId) =>
  buildDocumentViewLinks("quotation", quotationId);
