import AquaInvoice from "../../models/crm/invoice.js";

const INDIAN_PHONE_REGEX = /^[6-9]\d{9}$/;

const normalizePhone = (value = "") => {
  const digits = String(value).replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91")
    ? digits.slice(2)
    : digits.slice(0, 10);
};

const normalizeEmail = (value = "") => String(value).trim().toLowerCase();

const invoiceFields =
  "_id invoiceNo date paidStatus products customerDetails.email aquakartOnlineUser createdAt";

const toInvoiceSummary = (invoice) => ({
  id: String(invoice._id),
  invoiceNo: invoice.invoiceNo || "Invoice",
  date: invoice.date || invoice.createdAt || null,
  paidStatus: invoice.paidStatus || "unpaid",
  itemCount: Array.isArray(invoice.products) ? invoice.products.length : 0,
});

const linkInvoiceToEmail = async (invoice, email) => {
  const currentEmail = normalizeEmail(invoice?.customerDetails?.email);

  if (currentEmail && currentEmail !== email) {
    return { invoice: null, restricted: true, linked: false };
  }

  if (currentEmail === email) {
    if (!invoice.aquakartOnlineUser) {
      await AquaInvoice.updateOne(
        { _id: invoice._id },
        { $set: { aquakartOnlineUser: true } },
      );
    }
    return { invoice, restricted: false, linked: false };
  }

  const linkedInvoice = await AquaInvoice.findOneAndUpdate(
    {
      _id: invoice._id,
      $or: [
        { "customerDetails.email": { $exists: false } },
        { "customerDetails.email": null },
        { "customerDetails.email": "" },
      ],
    },
    {
      $set: {
        "customerDetails.email": email,
        aquakartOnlineUser: true,
      },
    },
    { new: true },
  ).select(invoiceFields);

  if (linkedInvoice) {
    return { invoice: linkedInvoice, restricted: false, linked: true };
  }

  const latestInvoice = await AquaInvoice.findById(invoice._id).select(
    invoiceFields,
  );
  const latestEmail = normalizeEmail(latestInvoice?.customerDetails?.email);

  if (latestInvoice && latestEmail === email) {
    return { invoice: latestInvoice, restricted: false, linked: false };
  }

  return { invoice: null, restricted: true, linked: false };
};

const getInvoicesByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);

    if (!INDIAN_PHONE_REGEX.test(phone)) {
      return res.status(400).json({
        success: false,
        found: false,
        requiresLogin: false,
        message: "Please enter a valid 10-digit Indian mobile number.",
      });
    }

    const invoices = await AquaInvoice.find({
      "customerDetails.phone": Number(phone),
    })
      .select(invoiceFields)
      .sort({ createdAt: -1 });

    if (!invoices.length) {
      return res.status(200).json({
        success: true,
        found: false,
        requiresLogin: false,
        count: 0,
        purchases: [],
        message: "No invoice was found for this phone number.",
      });
    }

    if (!req.user) {
      return res.status(200).json({
        success: true,
        found: true,
        requiresLogin: true,
        count: invoices.length,
        purchases: [],
        message:
          "We found an invoice for this phone number. Continue with Google to view it securely.",
      });
    }

    const email = normalizeEmail(req.user.email);
    if (!email) {
      return res.status(400).json({
        success: false,
        found: true,
        requiresLogin: true,
        purchases: [],
        message: "Your Google account does not contain a usable email address.",
      });
    }

    const linkResults = await Promise.all(
      invoices.map((invoice) => linkInvoiceToEmail(invoice, email)),
    );
    const accessibleInvoices = linkResults
      .map((result) => result.invoice)
      .filter(Boolean);
    const restrictedCount = linkResults.filter(
      (result) => result.restricted,
    ).length;
    const linkedCount = linkResults.filter((result) => result.linked).length;

    if (!accessibleInvoices.length && restrictedCount > 0) {
      return res.status(403).json({
        success: false,
        found: true,
        requiresLogin: false,
        purchases: [],
        message:
          "The invoice linked to this phone number belongs to a different email address.",
      });
    }

    const purchases = accessibleInvoices.map(toInvoiceSummary);
    const countMessage =
      purchases.length === 1
        ? "We found 1 invoice linked to your account."
        : `We found ${purchases.length} invoices linked to your account.`;
    const linkMessage = linkedCount
      ? " Your Google email was added to the incomplete invoice record."
      : "";

    return res.status(200).json({
      success: true,
      found: purchases.length > 0,
      requiresLogin: false,
      count: purchases.length,
      restrictedCount,
      linkedCount,
      purchases,
      message: `${countMessage}${linkMessage}`,
    });
  } catch (error) {
    console.error("Public invoice phone lookup failed:", error.message);
    return res.status(500).json({
      success: false,
      found: false,
      requiresLogin: false,
      purchases: [],
      message: "We could not check your invoices right now. Please try again.",
    });
  }
};

export default { getInvoicesByPhone };
