const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const crmInvoiceDeliveryEmail = ({
  customerName,
  invoiceNo,
  invoiceDate,
  invoiceTotal,
  invoiceUrl,
}) => {
  const safeInvoiceNo = invoiceNo || "Aquakart invoice";
  const firstName = String(customerName || "Customer")
    .trim()
    .split(/\s+/)[0];
  const detailRows = [
    invoiceNo && `<div style="margin-bottom:8px"><strong>Invoice:</strong> ${escapeHtml(invoiceNo)}</div>`,
    invoiceDate && `<div style="margin-bottom:8px"><strong>Date:</strong> ${escapeHtml(invoiceDate)}</div>`,
    invoiceTotal && `<div><strong>Total:</strong> ${escapeHtml(invoiceTotal)}</div>`,
  ]
    .filter(Boolean)
    .join("");

  return {
    subject: `Your Aquakart invoice ${safeInvoiceNo}`,
    text: `Hello ${firstName}, your Aquakart invoice ${safeInvoiceNo} is ready. View it securely: ${invoiceUrl}`,
    html: `<!doctype html><html><body style="margin:0;background:#f3faf7;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:620px;margin:0 auto;padding:32px 18px"><div style="background:#047857;color:white;padding:24px 28px;border-radius:22px 22px 0 0"><div style="font-size:26px;font-weight:800">Aquakart</div><div style="margin-top:6px;color:#a7f3d0">Water, thoughtfully solved.</div></div><div style="background:white;padding:30px 28px;border-radius:0 0 22px 22px"><p style="margin-top:0">Hello ${escapeHtml(firstName)},</p><h1 style="font-size:24px;line-height:1.3">Your invoice is ready</h1><p style="line-height:1.7;color:#475569">Aquakart has sent you the invoice below.</p><div style="margin:20px 0;padding:18px;border:1px solid #dbe8e5;border-radius:14px;background:#f8fbfa">${detailRows}</div><a href="${escapeHtml(invoiceUrl)}" style="display:inline-block;margin:18px 0;padding:14px 22px;border-radius:12px;background:#047857;color:white;text-decoration:none;font-weight:700">View invoice</a><p style="font-size:13px;line-height:1.6;color:#64748b">For your protection, invoice access may require verification of the Google account connected to your purchase.</p><hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0"><p style="font-size:13px;color:#64748b">Aquakart Support · support@aquakart.co.in · +91 90147 74667</p></div></div></body></html>`,
  };
};

export default crmInvoiceDeliveryEmail;
