// Quotation totals, shared by quotations and pre-invoices
// (src/services/offlinePayments/preInvoices.js). A line is
// max(qty * price - discount, 0) + tax; the document total is
// max(sum(lines) - discount, 0) + tax. Moved unchanged from
// src/controllers/crm/quotation.js.

export const calculateTotals = (payload = {}) => {
  const products = Array.isArray(payload.products) ? payload.products : [];
  let subTotal = 0;

  const calculatedProducts = products.map((product) => {
    const quantity = Number(product.productQuantity) || 0;
    const price = Number(product.productPrice) || 0;
    const discount = Number(product.productDiscount) || 0;
    const tax = Number(product.productTax) || 0;
    const productTotal = Math.max(quantity * price - discount, 0) + tax;
    subTotal += productTotal;
    return { ...product, productTotal };
  });

  const discount = Number(payload.discount) || 0;
  const tax = Number(payload.tax) || 0;
  const totalAmount = Math.max(subTotal - discount, 0) + tax;

  return {
    products: calculatedProducts,
    subTotal,
    discount,
    tax,
    totalAmount,
  };
};
