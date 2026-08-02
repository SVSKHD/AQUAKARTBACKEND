const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const invoiceAccessEmail = ({
  customerName,
  invoiceCount,
  accessUrl,
  invoiceNo,
  invoiceDate,
  invoiceTotal,
}) => {
  const title = invoiceNo
    ? `Your Aquakart invoice ${invoiceNo}`
    : "Your Aquakart invoices";
  const firstName = escapeHtml(
    String(customerName || "Customer")
      .trim()
      .split(/\s+/)[0],
  );
  const safeUrl = escapeHtml(accessUrl);
  const summary = invoiceNo
    ? `Your invoice ${escapeHtml(invoiceNo)} is ready to view.`
    : `We found ${invoiceCount} Aquakart ${invoiceCount === 1 ? "invoice" : "invoices"} linked to your purchase.`;

  const details = invoiceNo
    ? `<div style="margin:20px 0;padding:18px;border:1px solid #dbe8e5;border-radius:14px;background:#f8fbfa"><div style="margin-bottom:8px"><strong>Invoice:</strong> ${escapeHtml(invoiceNo)}</div><div style="margin-bottom:8px"><strong>Date:</strong> ${escapeHtml(invoiceDate || "Available in your invoice")}</div><div><strong>Total:</strong> ${escapeHtml(invoiceTotal || "Available in your invoice")}</div></div>`
    : "";

  return {
    subject: title,
    text: `${summary}${invoiceDate ? ` Date: ${invoiceDate}.` : ""}${invoiceTotal ? ` Total: ${invoiceTotal}.` : ""} Open this secure link within 15 minutes: ${accessUrl} If you did not request this email, ignore it.`,
    html: `<!doctype html><html><body style="margin:0;background:#f3faf7;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:620px;margin:0 auto;padding:32px 18px"><div style="background:#047857;color:white;padding:24px 28px;border-radius:22px 22px 0 0"><div style="font-size:26px;font-weight:800">Aquakart</div><div style="margin-top:6px;color:#a7f3d0">Water, thoughtfully solved.</div></div><div style="background:white;padding:30px 28px;border-radius:0 0 22px 22px"><p style="margin-top:0">Hello ${firstName},</p><h1 style="font-size:24px;line-height:1.3">${escapeHtml(title)}</h1><p style="line-height:1.7;color:#475569">${summary}</p>${details}<a href="${safeUrl}" style="display:inline-block;margin:18px 0;padding:14px 22px;border-radius:12px;background:#047857;color:white;text-decoration:none;font-weight:700">View secure invoice</a><p style="font-size:13px;line-height:1.6;color:#64748b">This one-time secure link expires in 15 minutes. If you did not request this email, you can safely ignore it.</p><hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0"><p style="font-size:13px;color:#64748b">Aquakart Support · support@aquakart.co.in · +91 90147 74667</p></div></div></body></html>`,
  };
};

export default invoiceAccessEmail;
