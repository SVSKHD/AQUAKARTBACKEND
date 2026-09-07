export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function parseReportPeriod(monthValue, yearValue = "2026") {
  const value = String(monthValue || "").toLowerCase();
  const month = /^(0?[1-9]|1[0-2])$/.test(value)
    ? Number(value)
    : MONTHS.findIndex((name) => name.toLowerCase() === value) + 1;
  if (!month || !/^[1-9]\d{3}$/.test(String(yearValue))) return null;
  const year = Number(yearValue);
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  return { month, year, prefix, label: `${MONTHS[month - 1]} ${year}` };
}

export function reportQuery(period) {
  // Invoice dates are stored as YYYY-MM-DD strings. Never use delivery date.
  // Older records without an invoice date fall back to creation time in IST.
  const offset = 330 * 60 * 1000;
  const start = new Date(Date.UTC(period.year, period.month - 1, 1) - offset);
  const end = new Date(Date.UTC(period.year, period.month, 1) - offset);
  return {
    $or: [
      { date: { $regex: `^${period.prefix}-` } },
      { date: { $in: [null, ""] }, createdAt: { $gte: start, $lt: end } },
    ],
  };
}

const text = (value) => ({ value: String(value ?? ""), type: String });
const money = (value) => ({ value, type: Number, format: "#,##0.00" });
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const headers = (values) => values.map((value) => ({
  ...text(value), fontWeight: "bold", backgroundColor: "#E2E8F0",
}));
const formatDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
};

export function buildReportSheets(invoices) {
  const invoiceRows = [headers([
    "Invoice No", "Date", "Customer", "Phone", "Email", "Address", "GST", "PO",
    "GST No", "Payment Type", "Delivery Date", "Delivered By", "Base Price",
    "GST (18%)", "Total Amount", "Status", "Link",
  ])];
  const productRows = [headers(["Invoice No", "Product", "Quantity", "Price", "Serial No"])];
  for (const invoice of invoices) {
    const customer = invoice.customerDetails || {};
    const products = invoice.products || [];
    // Preserve CRM's current price semantics and GST calculation for export parity.
    // productPrice is summed as in InvoicesTab, not multiplied by quantity here.
    const total = number(invoice.total_amount ?? invoice.total ?? products.reduce((sum, p) => sum + number(p.productPrice), 0));
    const base = Math.floor(total * 0.8474594);
    const gst = Math.floor(base * 0.18);
    invoiceRows.push([
      text(invoice.invoiceNo), text(formatDate(invoice.date || invoice.createdAt)),
      text(customer.name), text(customer.phone), text(customer.email), text(customer.address),
      text(invoice.gst ? "Yes" : "No"), text(invoice.po ? "Yes" : "No"),
      text(invoice.gstDetails?.gstNo), text(invoice.paymentType),
      text(formatDate(invoice.transport?.deliveryDate)), text(invoice.transport?.deliveredBy),
      money(base), money(gst), money(total), text(invoice.paidStatus),
      text(`https://aquakart.co.in/invoice/${invoice._id}`),
    ]);
    for (const product of products) productRows.push([
      text(invoice.invoiceNo), text(product.productName),
      { value: number(product.productQuantity), type: Number },
      money(number(product.productPrice)), text(product.productSerialNo),
    ]);
  }
  return [
    { sheet: "Invoices", data: invoiceRows, stickyRowsCount: 1,
      columns: [24, 14, 24, 16, 28, 40, 8, 8, 20, 16, 16, 18, 16, 16, 16, 14, 52].map((width) => ({ width })) },
    { sheet: "Products", data: productRows, stickyRowsCount: 1,
      columns: [24, 36, 12, 16, 24].map((width) => ({ width })) },
  ];
}
