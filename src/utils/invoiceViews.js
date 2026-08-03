const CUSTOMER_ORIGIN = (
  process.env.INVOICE_CUSTOMER_ORIGIN || "https://aquakart.co.in"
).replace(/\/$/, "");
const ADMIN_ORIGIN = (
  process.env.INVOICE_ADMIN_ORIGIN || "https://admin.aquakart.co.in"
).replace(/\/$/, "");

export const buildInvoiceViewLinks = (invoiceId) => {
  const id = String(invoiceId || "").trim();
  if (!id) throw new Error("Invoice ID is required");

  return {
    invoiceId: id,
    adminUrl: `${ADMIN_ORIGIN}/admin/invoice/${encodeURIComponent(id)}`,
    customerUrl: `${CUSTOMER_ORIGIN}/invoice/${encodeURIComponent(id)}`,
  };
};
