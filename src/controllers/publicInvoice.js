import crypto from "crypto";
import mongoose from "mongoose";
import AquaInvoice from "../models/crm/invoice.js";
import InvoiceAccessToken from "../models/invoiceAccessToken.js";
import NotificationLog from "../models/crm/notificationLog.js";
import sendEmail from "../notifications/email/send-email.js";
import invoiceAccessEmail from "../utils/emailTemplates/invoiceAccessEmail.js";
import {
  calculateInvoiceTotal,
  createOpaqueToken,
  hashToken,
  maskEmail,
  normalizeEmail,
  normalizeIndianPhone,
  signInvoiceAccessToken,
} from "../utils/invoiceAccess.js";

const hashRequestValue = (value = "") =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const findInvoicesByPhone = async (phoneNormalized) =>
  AquaInvoice.find({
    $or: [
      { customerPhoneNormalized: phoneNormalized },
      { "customerDetails.phone": phoneNormalized },
      { "customerDetails.phone": Number(phoneNormalized) },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();

const getInvoiceEmail = (invoices = []) => {
  for (const invoice of invoices) {
    const email = normalizeEmail(
      invoice.customerEmailNormalized ||
        invoice.customerDetails?.email ||
        invoice.gstDetails?.gstEmail,
    );
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  }
  return "";
};

const getCustomerName = (invoices = []) =>
  invoices.find((invoice) => invoice.customerDetails?.name)?.customerDetails
    ?.name || "Customer";

const accessExpiryMinutes = () => {
  const configured = Number(
    process.env.INVOICE_ACCESS_TOKEN_EXPIRY_MINUTES || 15,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 15;
};

const createEmailAccess = async ({
  invoices,
  phoneNormalized,
  req,
  purpose,
}) => {
  const email = getInvoiceEmail(invoices);
  if (!email) {
    const error = new Error("No email address is attached to these invoices");
    error.statusCode = 422;
    throw error;
  }

  const token = createOpaqueToken();
  const expiresInMinutes = accessExpiryMinutes();
  await InvoiceAccessToken.create({
    tokenHash: hashToken(token),
    phoneNormalized,
    emailNormalized: email,
    invoiceIds: invoices.map((invoice) => invoice._id),
    purpose,
    expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
    requestIpHash: hashRequestValue(req.ip),
    userAgentHash: hashRequestValue(req.get("user-agent")),
  });

  const frontendUrl = (
    process.env.FRONTEND_URL || "https://aquakart.co.in"
  ).replace(/\/$/, "");
  const accessUrl = `${frontendUrl}/invoice/access?token=${encodeURIComponent(token)}`;
  const invoiceNo = invoices.length === 1 ? invoices[0].invoiceNo : "";
  const template = invoiceAccessEmail({
    customerName: getCustomerName(invoices),
    invoiceCount: invoices.length,
    accessUrl,
    invoiceNo,
  });
  const delivery = await sendEmail({
    email,
    subject: template.subject,
    message: template.text,
    content: template.html,
  });

  await NotificationLog.create({
    invoiceId: invoices.length === 1 ? invoices[0]._id : undefined,
    channel: "email",
    recipientMasked: maskEmail(email),
    template: invoiceNo ? "invoice-delivery" : "invoice-access",
    message: template.subject,
    status: delivery.success ? "sent" : "failed",
    providerMessageId: delivery.messageId,
    errorCode: delivery.code,
    response: delivery.success ? undefined : delivery.message,
  });

  if (!delivery.success) {
    await InvoiceAccessToken.deleteOne({ tokenHash: hashToken(token) });
    const error = new Error(delivery.message || "Unable to send invoice email");
    error.statusCode = delivery.code === "EMAIL_NOT_CONFIGURED" ? 503 : 502;
    throw error;
  }

  return { email, expiresInMinutes };
};

const lookup = async (req, res) => {
  try {
    const phone = normalizeIndianPhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({
        success: false,
        found: false,
        message: "Enter a valid 10-digit Indian mobile number",
      });
    }

    const invoices = await findInvoicesByPhone(phone);
    if (!invoices.length) {
      return res.status(200).json({
        success: true,
        found: false,
        invoiceCount: 0,
        message: "You have no purchases yet.",
      });
    }

    const email = getInvoiceEmail(invoices);
    return res.status(200).json({
      success: true,
      found: true,
      invoiceCount: invoices.length,
      maskedEmail: maskEmail(email),
      canEmail: Boolean(email),
      message: `We found ${invoices.length} Aquakart ${invoices.length === 1 ? "invoice" : "invoices"}.`,
    });
  } catch {
    return res.status(500).json({
      success: false,
      message: "We could not check your invoices right now",
    });
  }
};

const requestAccess = async (req, res) => {
  try {
    const phone = normalizeIndianPhone(req.body?.phone);
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid phone number" });
    }
    const invoices = await findInvoicesByPhone(phone);
    if (!invoices.length) {
      return res.status(200).json({
        success: true,
        message: "If invoices are available, a secure link will be sent.",
      });
    }
    const { email, expiresInMinutes } = await createEmailAccess({
      invoices,
      phoneNormalized: phone,
      req,
      purpose: "invoice-list",
    });
    return res.status(202).json({
      success: true,
      message: "A secure invoice link has been sent.",
      maskedEmail: maskEmail(email),
      expiresInMinutes,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Unable to send invoice access email",
    });
  }
};

const exchange = async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    if (!token)
      return res
        .status(400)
        .json({ success: false, message: "Token is required" });
    const record = await InvoiceAccessToken.findOneAndUpdate(
      {
        tokenHash: hashToken(token),
        consumedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { consumedAt: new Date() } },
      { new: true },
    ).lean();
    if (!record) {
      return res.status(401).json({
        success: false,
        message: "This invoice link is invalid, expired or already used",
      });
    }
    const accessToken = signInvoiceAccessToken({
      invoiceIds: record.invoiceIds,
      email: record.emailNormalized,
    });
    return res
      .status(200)
      .json({ success: true, accessToken, expiresIn: 1800 });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Unable to verify invoice access",
    });
  }
};

const loginAccess = async (req, res) => {
  try {
    const phone = normalizeIndianPhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 10-digit Indian mobile number",
      });
    }

    const invoices = await findInvoicesByPhone(phone);
    if (!invoices.length) {
      return res.status(404).json({
        success: false,
        message: "You have no purchases yet.",
      });
    }

    const firebaseUser = req.firebaseUser;
    const linkedToAnotherGoogleAccount = invoices.some(
      (invoice) =>
        invoice.firebaseUid && invoice.firebaseUid !== firebaseUser.uid,
    );
    if (linkedToAnotherGoogleAccount) {
      return res.status(403).json({
        success: false,
        message: "These invoices are linked to another Google account",
      });
    }

    await Promise.all(
      invoices.map((invoice) => {
        const customerDetails = invoice.customerDetails || {};
        const update = {
          firebaseUid: firebaseUser.uid,
          customerEmailNormalized: firebaseUser.email,
        };
        if (!customerDetails.email) {
          update["customerDetails.email"] = firebaseUser.email;
        }
        if (!customerDetails.name && firebaseUser.name) {
          update["customerDetails.name"] = firebaseUser.name;
        }
        return AquaInvoice.updateOne({ _id: invoice._id }, { $set: update });
      }),
    );

    const accessToken = signInvoiceAccessToken({
      invoiceIds: invoices.map((invoice) => invoice._id),
      email: firebaseUser.email,
      firebaseUid: firebaseUser.uid,
    });

    return res.status(200).json({
      success: true,
      authenticated: true,
      accessToken,
      expiresIn: 1800,
      invoiceCount: invoices.length,
      redirectInvoiceId:
        invoices.length === 1 ? String(invoices[0]._id) : undefined,
      user: {
        firebaseUid: firebaseUser.uid,
        email: firebaseUser.email,
        name: firebaseUser.name,
        photoURL: firebaseUser.picture,
      },
      message: "Google account verified. Your invoices are ready.",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Unable to open invoices with Google",
    });
  }
};

const toSummary = (invoice) => ({
  id: String(invoice._id),
  invoiceNo: invoice.invoiceNo || String(invoice._id),
  date: invoice.date || invoice.createdAt,
  paidStatus: invoice.paidStatus || "Not available",
  itemCount: invoice.products?.length || 0,
  total: calculateInvoiceTotal(invoice),
});

const list = async (req, res) => {
  const invoices = await AquaInvoice.find({
    _id: { $in: req.invoiceAccess.invoiceIds },
  })
    .sort({ createdAt: -1 })
    .lean();
  return res.status(200).json({
    success: true,
    maskedEmail: maskEmail(req.invoiceAccess.email),
    invoices: invoices.map(toSummary),
  });
};

const getById = async (req, res) => {
  const { id } = req.params;
  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !req.invoiceAccess.invoiceIds.includes(id)
  ) {
    return res
      .status(404)
      .json({ success: false, message: "Invoice not found" });
  }
  const invoice = await AquaInvoice.findById(id).lean();
  if (!invoice)
    return res
      .status(404)
      .json({ success: false, message: "Invoice not found" });
  return res.status(200).json(invoice);
};

const emailById = async (req, res) => {
  try {
    const { id } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(id) ||
      !req.invoiceAccess.invoiceIds.includes(id)
    ) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }
    const invoice = await AquaInvoice.findById(id).lean();
    if (!invoice)
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    const phone = normalizeIndianPhone(invoice.customerDetails?.phone);
    const { email } = await createEmailAccess({
      invoices: [invoice],
      phoneNormalized: phone,
      req,
      purpose: "invoice-delivery",
    });
    return res.status(202).json({
      success: true,
      message: "Invoice emailed successfully.",
      maskedEmail: maskEmail(email),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : "Unable to email invoice",
    });
  }
};

export default {
  lookup,
  requestAccess,
  exchange,
  loginAccess,
  list,
  getById,
  emailById,
};
