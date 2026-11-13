// Builds the invoice payload for a quotation that was sold.
//
// Invoice rules (shared with the CRM): `productPrice` on an invoice line is the
// LINE value, never multiplied by quantity. A quotation line is
// max(qty * price - discount, 0) + tax, and the quotation-level discount/tax is
// spread over the lines in proportion so the invoice total equals the
// quotation total.
//
// The invoice is a normal sales invoice: `quotation` stays false because that
// flag excludes a document from GST sales reports.

const OBJECT_ID = /^[a-f\d]{24}$/i;

const PAID_STATUSES = new Set(["unpaid", "partial", "paid"]);
const PAYMENT_TYPES = new Set(["cash", "card", "upi", "bank_transfer"]);

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const roundMoney = (value) => Math.round(value * 100) / 100;

const plain = (doc) =>
  doc && typeof doc.toObject === "function" ? doc.toObject() : doc || {};

export const quotationLineTotal = (product = {}) =>
  Math.max(
    toNumber(product.productQuantity) * toNumber(product.productPrice) -
      toNumber(product.productDiscount),
    0,
  ) + toNumber(product.productTax);

// Line values that add up to the quotation total (2 decimals; the rounding
// remainder goes to the largest line).
export const invoiceLineValues = (quotation = {}) => {
  const products = Array.isArray(quotation.products) ? quotation.products : [];
  const lines = products.map(quotationLineTotal);
  const subTotal = lines.reduce((sum, value) => sum + value, 0);
  const total = roundMoney(
    Math.max(subTotal - toNumber(quotation.discount), 0) +
      toNumber(quotation.tax),
  );

  if (!lines.length) return [];
  if (subTotal <= 0) {
    // Nothing to spread over: put any quotation-level tax on the first line.
    return lines.map((_, index) => (index === 0 ? total : 0));
  }

  const scaled = lines.map((value) => roundMoney((value / subTotal) * total));
  const drift = roundMoney(
    total - scaled.reduce((sum, value) => sum + value, 0),
  );
  if (drift !== 0) {
    const largest = scaled.indexOf(Math.max(...scaled));
    scaled[largest] = roundMoney(scaled[largest] + drift);
  }
  return scaled;
};

export const mapQuotationToInvoicePayload = (quotationDoc, options = {}) => {
  const quotation = plain(quotationDoc);
  const products = Array.isArray(quotation.products) ? quotation.products : [];
  const values = invoiceLineValues(quotation);
  const paidStatus = String(options.paidStatus || "").toLowerCase();
  const paymentType = String(options.paymentType || "").toLowerCase();
  const gst = quotation.gst === true;

  const invoiceProducts = products.map((product, index) => {
    const productId = product.productId ? String(product.productId) : "";
    return {
      productName: String(product.productName || "").trim(),
      productQuantity: toNumber(product.productQuantity) || 1,
      productPrice: values[index] ?? 0,
      productSerialNo: product.productSerialNo || "",
      ...(OBJECT_ID.test(productId) ? { productId } : {}),
    };
  });

  return {
    customerDetails: {
      name: quotation.customerDetails?.name || "",
      phone: quotation.customerDetails?.phone,
      email: quotation.customerDetails?.email || "",
      address: quotation.customerDetails?.address || "",
    },
    gst,
    po: options.po === true,
    quotation: false,
    gstDetails: gst ? { ...(quotation.gstDetails || {}) } : {},
    products: invoiceProducts,
    paidStatus: PAID_STATUSES.has(paidStatus) ? paidStatus : "unpaid",
    paymentType: PAYMENT_TYPES.has(paymentType) ? paymentType : "cash",
    productId: invoiceProducts.find((product) => product.productId)?.productId,
    sourceQuotationId: quotation._id,
    sourceQuotationNo: quotation.quotationNo || "",
  };
};
