import mongoose from "mongoose";
import AquaInvoice from "../models/crm/invoice.js";
import InvoiceAccessToken from "../models/invoiceAccessToken.js";
import NotificationLog from "../models/crm/notificationLog.js";
import sendEmail from "../notifications/email/send-email.js";
import { getWhatsAppInvoiceSharingStatus } from "../services/invoiceSharing/whatsappInvoiceSharing.js";
import invoiceAccessEmail from "../utils/emailTemplates/invoiceAccessEmail.js";
import {
  buildInvoiceEmailAudit,
  buildEmailDeliveryDedupeKey,
  calculateInvoiceTotal,
  createOpaqueToken,
  getInvoiceEmail,
  getInvoiceOwnershipState,
  hashAuditValue,
  hashToken,
  isDirectInvoiceAccessAllowed,
  maskEmail,
  normalizeIndianPhone,
  signInvoiceAccessToken,
  validateEmail,
} from "../utils/invoiceAccess.js";

const GENERIC_LOOKUP_MESSAGE =
  "If matching invoices are available, you can continue securely with your verified Google account.";

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

const getCustomerName = (invoices = []) =>
  invoices.find((invoice) => invoice.customerDetails?.name)?.customerDetails
    ?.name || "Customer";

const getFirstInvoiceEmail = (invoices = []) => {
  const invoiceWithEmail = invoices.find((invoice) => getInvoiceEmail(invoice));
  return invoiceWithEmail ? getInvoiceEmail(invoiceWithEmail) : "";
};

const accessExpiryMinutes = () => {
  const configured = Number(
    process.env.INVOICE_ACCESS_TOKEN_EXPIRY_MINUTES || 15,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 15;
};

const formatInvoiceDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
};

const formatInvoiceTotal = (invoice) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(calculateInvoiceTotal(invoice));

const createEmailAccess = async ({
  invoices,
  phoneNormalized,
  recipientEmail,
  req,
  purpose,
  firebaseUid,
  notificationLogId,
}) => {
  const email = validateEmail(recipientEmail || getFirstInvoiceEmail(invoices));
  if (!email) {
    const error = new Error("Enter a valid delivery email address");
    error.statusCode = 400;
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
    requestIpHash: hashAuditValue(req.ip),
    userAgentHash: hashAuditValue(req.get("user-agent")),
  });

  const frontendUrl = (
    process.env.FRONTEND_PUBLIC_URL ||
    process.env.FRONTEND_URL ||
    "https://aquakart.co.in"
  ).replace(/\/$/, "");
  const accessUrl = `${frontendUrl}/invoice/access?token=${encodeURIComponent(token)}`;
  const invoice = invoices.length === 1 ? invoices[0] : null;
  const invoiceNo = invoice?.invoiceNo || "";
  const template = invoiceAccessEmail({
    customerName: getCustomerName(invoices),
    invoiceCount: invoices.length,
    accessUrl,
    invoiceNo,
    invoiceDate: invoice
      ? formatInvoiceDate(invoice.date || invoice.createdAt)
      : "",
    invoiceTotal: invoice ? formatInvoiceTotal(invoice) : "",
  });

  let logId = notificationLogId;
  if (!logId) {
    const log = await NotificationLog.create({
      invoiceId: invoice?._id,
      channel: "email",
      recipientMasked: maskEmail(email),
      template: invoiceNo ? "invoice-delivery" : "invoice-access",
      message: template.subject,
      status: "pending",
      firebaseUid,
      requestIpHash: hashAuditValue(req.ip),
    });
    logId = log._id;
  }

  const delivery = await sendEmail({
    email,
    subject: template.subject,
    message: template.text,
    content: template.html,
  });

  await NotificationLog.findByIdAndUpdate(logId, {
    $set: {
      status: delivery.success ? "sent" : "failed",
      providerMessageId: delivery.messageId,
      errorCode: delivery.code,
      response: delivery.success ? undefined : "Provider delivery failed",
    },
  });

  if (!delivery.success) {
    await InvoiceAccessToken.deleteOne({ tokenHash: hashToken(token) });
    const error = new Error("We could not send the invoice right now");
    error.statusCode = delivery.code === "EMAIL_NOT_CONFIGURED" ? 503 : 502;
    throw error;
  }

  return { email, expiresInMinutes };
};

const lookup = async (req, res) => {
  const phone = normalizeIndianPhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid 10-digit Indian mobile number",
    });
  }

  return res.status(200).json({
    success: true,
    authenticated: Boolean(req.firebaseUser?.uid),
    message: GENERIC_LOOKUP_MESSAGE,
  });
};

const requestAccess = async (req, res) => {
  const phone = normalizeIndianPhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid 10-digit Indian mobile number",
    });
  }

  try {
    const invoices = await findInvoicesByPhone(phone);
    if (invoices.length && getFirstInvoiceEmail(invoices)) {
      await createEmailAccess({
        invoices,
        phoneNormalized: phone,
        req,
        purpose: "invoice-list",
      });
    }
  } catch (error) {
    console.error("Invoice access delivery failed:", error.statusCode || 500);
  }

  return res.status(202).json({
    success: true,
    message: "If invoices are available, a secure link will be sent.",
  });
};

const exchange = async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    if (!token) {
      return res
        .status(400)
        .json({ success: false, message: "Token is required" });
    }
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
      grant: record.purpose === "invoice-delivery" ? "delivery" : "owner",
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

const getEmailStatus = (invoice, verifiedEmail) => {
  const invoiceEmail = getInvoiceEmail(invoice);
  if (!invoiceEmail) return "missing";
  return invoiceEmail === verifiedEmail ? "matches" : "different";
};

const toSummary = (invoice, identity = {}) => {
  const ownershipState = getInvoiceOwnershipState(invoice, identity);
  return {
    id: String(invoice._id),
    invoiceNo: invoice.invoiceNo || String(invoice._id),
    date: invoice.date || invoice.createdAt,
    paidStatus: invoice.paidStatus || "Not available",
    itemCount: invoice.products?.length || 0,
    total: calculateInvoiceTotal(invoice),
    emailStatus: getEmailStatus(invoice, validateEmail(identity.email)),
    maskedExistingEmail: maskEmail(getInvoiceEmail(invoice)),
    claimRequired: ["email-missing", "email-different"].includes(
      ownershipState,
    ),
    canView: ["owned", "email-match"].includes(ownershipState),
    whatsapp: getWhatsAppInvoiceSharingStatus(),
  };
};

const bindMatchingInvoice = async (invoice, firebaseUser) => {
  const state = getInvoiceOwnershipState(invoice, firebaseUser);
  if (state !== "email-match") return { invoice, state };

  const existingFirebaseUid = String(invoice.firebaseUid || "");
  const ownershipFilter = existingFirebaseUid
    ? { firebaseUid: existingFirebaseUid }
    : {
        $or: [
          { firebaseUid: { $exists: false } },
          { firebaseUid: null },
          { firebaseUid: "" },
        ],
      };

  const linked = await AquaInvoice.findOneAndUpdate(
    {
      _id: invoice._id,
      ...ownershipFilter,
    },
    {
      $set: {
        firebaseUid: firebaseUser.uid,
        customerEmailNormalized: firebaseUser.email,
        aquakartOnlineUser: true,
      },
    },
    { new: true },
  ).lean();

  if (linked) return { invoice: linked, state: "owned" };
  const latest = await AquaInvoice.findById(invoice._id).lean();
  return {
    invoice: latest,
    state: getInvoiceOwnershipState(latest, firebaseUser),
  };
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
    const { firebaseUser } = req;
    const customerEmail = validateEmail(req.user?.email);
    const evaluated = await Promise.all(
      invoices.map((invoice) => bindMatchingInvoice(invoice, firebaseUser)),
    );
    const accessible = evaluated.filter(
      ({ state, invoice }) => invoice && state !== "restricted",
    );

    if (!accessible.length) {
      return res.status(200).json({
        success: true,
        found: false,
        invoiceCount: 0,
        invoices: [],
        message:
          "We could not verify invoices for those details. Check the number and try again.",
      });
    }

    const accessToken = signInvoiceAccessToken({
      invoiceIds: accessible.map(({ invoice }) => invoice._id),
      email: firebaseUser.email,
      firebaseUid: firebaseUser.uid,
    });
    const invoiceSummaries = accessible.map(({ invoice }) =>
      toSummary(invoice, firebaseUser),
    );
    const directlyViewable = invoiceSummaries.filter(
      (invoice) => invoice.canView,
    );

    return res.status(200).json({
      success: true,
      authenticated: true,
      found: true,
      accessToken,
      expiresIn: 1800,
      invoiceCount: invoiceSummaries.length,
      invoices: invoiceSummaries,
      redirectInvoiceId:
        invoiceSummaries.length === 1 && directlyViewable.length === 1
          ? invoiceSummaries[0].id
          : undefined,
      user: {
        firebaseUid: firebaseUser.uid,
        email: firebaseUser.email,
        name: firebaseUser.name,
        photoURL: firebaseUser.picture,
        customerEmailStatus: !customerEmail
          ? "missing"
          : customerEmail === firebaseUser.email
            ? "matches"
            : "different",
        maskedCustomerEmail: maskEmail(customerEmail),
      },
      message:
        invoiceSummaries.length === 1
          ? "We found 1 invoice. Confirm its email before sharing."
          : `We found ${invoiceSummaries.length} invoices. Confirm an invoice email before sharing.`,
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

const loginDirectAccess = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const invoice = await AquaInvoice.findById(id).lean();
    if (!invoice) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const { firebaseUser } = req;
    if (!isDirectInvoiceAccessAllowed(invoice, firebaseUser)) {
      return res.status(403).json({
        success: false,
        verificationRequired: true,
        message:
          "This Google account does not match the invoice. Verify the purchase phone number to continue.",
      });
    }

    const linked = await bindMatchingInvoice(invoice, firebaseUser);
    if (!linked.invoice || linked.state !== "owned") {
      return res.status(403).json({
        success: false,
        verificationRequired: true,
        message:
          "This Google account does not match the invoice. Verify the purchase phone number to continue.",
      });
    }

    const accessToken = signInvoiceAccessToken({
      invoiceIds: [linked.invoice._id],
      email: firebaseUser.email,
      firebaseUid: firebaseUser.uid,
    });

    return res.status(200).json({
      success: true,
      authenticated: true,
      accessToken,
      expiresIn: 1800,
      redirectInvoiceId: String(linked.invoice._id),
      invoice: toSummary(linked.invoice, firebaseUser),
      message: "Invoice access verified with Google.",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Unable to open this invoice with Google",
    });
  }
};

const invoiceIdIsAllowed = (id, access) =>
  mongoose.Types.ObjectId.isValid(id) && access.invoiceIds.includes(id);

const canReadInvoice = (invoice, access) => {
  if (access.grant === "delivery") return true;
  if (access.firebaseUid) {
    return String(invoice.firebaseUid || "") === String(access.firebaseUid);
  }
  return getInvoiceEmail(invoice) === validateEmail(access.email);
};

const list = async (req, res) => {
  const invoices = await AquaInvoice.find({
    _id: { $in: req.invoiceAccess.invoiceIds },
  })
    .sort({ createdAt: -1 })
    .lean();
  return res.status(200).json({
    success: true,
    verifiedEmail: validateEmail(req.invoiceAccess.email),
    invoices: invoices.map((invoice) =>
      toSummary(invoice, {
        firebaseUid: req.invoiceAccess.firebaseUid,
        email: req.invoiceAccess.email,
      }),
    ),
  });
};

const getById = async (req, res) => {
  const { id } = req.params;
  if (!invoiceIdIsAllowed(id, req.invoiceAccess)) {
    return res
      .status(404)
      .json({ success: false, message: "Invoice not found" });
  }
  const invoice = await AquaInvoice.findById(id).lean();
  if (!invoice || !canReadInvoice(invoice, req.invoiceAccess)) {
    return res.status(403).json({
      success: false,
      message: "Confirm this invoice before opening it",
    });
  }
  await AquaInvoice.updateOne(
    { _id: id },
    {
      $inc: { "accessMetrics.openCount": 1 },
      $set: { "accessMetrics.lastOpenedAt": new Date() },
    },
  );
  const safeInvoice = { ...invoice };
  delete safeInvoice.emailUpdateAudit;
  delete safeInvoice.firebaseUid;
  delete safeInvoice.customerPhoneNormalized;
  delete safeInvoice.customerEmailNormalized;
  delete safeInvoice.accessMetrics;
  return res.status(200).json(safeInvoice);
};

const updateInvoiceOwnership = async ({
  invoice,
  access,
  emailAction,
  req,
  requireExistingOwner = false,
}) => {
  const verifiedEmail = validateEmail(access.email);
  const firebaseUid = String(access.firebaseUid || "");
  if (!verifiedEmail || !firebaseUid) {
    const error = new Error("A verified Google account is required");
    error.statusCode = 401;
    throw error;
  }

  const previousEmail = getInvoiceEmail(invoice);
  if (emailAction === "keep-existing" && !previousEmail) {
    const error = new Error("This invoice does not have an email to keep");
    error.statusCode = 422;
    throw error;
  }

  const query = { _id: invoice._id };
  if (requireExistingOwner) {
    query.firebaseUid = firebaseUid;
  } else {
    query.$or = [
      { firebaseUid },
      { firebaseUid: { $exists: false } },
      { firebaseUid: null },
      { firebaseUid: "" },
    ];
  }

  const update = {
    $set: {
      firebaseUid,
      aquakartOnlineUser: true,
    },
  };
  if (emailAction === "use-google-email") {
    update.$set["customerDetails.email"] = verifiedEmail;
    update.$set.customerEmailNormalized = verifiedEmail;
    if (previousEmail !== verifiedEmail) {
      update.$push = {
        emailUpdateAudit: buildInvoiceEmailAudit({
          previousEmail,
          newEmail: verifiedEmail,
          firebaseUid,
          requestIp: req.ip,
          userAgent: req.get("user-agent"),
        }),
      };
    }
  }

  const updated = await AquaInvoice.findOneAndUpdate(query, update, {
    new: true,
  }).lean();
  if (!updated) {
    const error = new Error("This invoice belongs to another Google account");
    error.statusCode = 403;
    throw error;
  }
  return updated;
};

const claimById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!invoiceIdIsAllowed(id, req.invoiceAccess)) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }
    const emailAction = String(req.body?.emailAction || "");
    if (!["keep-existing", "use-google-email"].includes(emailAction)) {
      return res.status(400).json({
        success: false,
        message: "Choose whether to keep or update the invoice email",
      });
    }
    const invoice = await AquaInvoice.findById(id).lean();
    if (!invoice) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }
    const updated = await updateInvoiceOwnership({
      invoice,
      access: req.invoiceAccess,
      emailAction,
      req,
    });
    return res.status(200).json({
      success: true,
      invoice: toSummary(updated, {
        firebaseUid: req.invoiceAccess.firebaseUid,
        email: req.invoiceAccess.email,
      }),
      message:
        emailAction === "use-google-email"
          ? "Invoice email updated to your verified Google email."
          : "Invoice connected to your Google account without changing its email.",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Unable to confirm invoice ownership",
    });
  }
};

const updateEmailById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!invoiceIdIsAllowed(id, req.invoiceAccess)) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        success: false,
        message: "Explicit confirmation is required to update invoice email",
      });
    }
    const invoice = await AquaInvoice.findById(id).lean();
    if (!invoice) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }
    const updated = await updateInvoiceOwnership({
      invoice,
      access: req.invoiceAccess,
      emailAction: "use-google-email",
      req,
      requireExistingOwner: true,
    });
    return res.status(200).json({
      success: true,
      invoice: toSummary(updated, {
        firebaseUid: req.invoiceAccess.firebaseUid,
        email: req.invoiceAccess.email,
      }),
      message: "Invoice email updated to your verified Google email.",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : "Unable to update email",
    });
  }
};

const emailById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!invoiceIdIsAllowed(id, req.invoiceAccess)) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }
    const recipientEmail = validateEmail(
      req.body?.recipientEmail || req.invoiceAccess.email,
    );
    if (!recipientEmail) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid delivery email address",
      });
    }
    const invoice = await AquaInvoice.findById(id).lean();
    if (!invoice || !canReadInvoice(invoice, req.invoiceAccess)) {
      return res.status(403).json({
        success: false,
        message: "Confirm this invoice before sharing it",
      });
    }
    if (!req.invoiceAccess.firebaseUid) {
      return res.status(403).json({
        success: false,
        message: "Google authentication is required to share an invoice",
      });
    }

    const dedupeKey = buildEmailDeliveryDedupeKey({
      invoiceId: id,
      firebaseUid: req.invoiceAccess.firebaseUid,
      recipientEmail,
    });
    let pendingLog;
    try {
      pendingLog = await NotificationLog.create({
        invoiceId: invoice._id,
        channel: "email",
        recipientMasked: maskEmail(recipientEmail),
        template: "invoice-delivery",
        message: `Invoice delivery ${invoice.invoiceNo || ""}`.trim(),
        status: "pending",
        firebaseUid: req.invoiceAccess.firebaseUid,
        requestIpHash: hashAuditValue(req.ip),
        dedupeKey,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await NotificationLog.findOne({ dedupeKey }).lean();
      return res.status(existing?.status === "sent" ? 200 : 409).json({
        success: existing?.status === "sent",
        duplicate: true,
        message:
          existing?.status === "sent"
            ? "This invoice was already emailed recently."
            : "An invoice email is already being processed.",
      });
    }

    const phone = normalizeIndianPhone(invoice.customerDetails?.phone);
    const { email } = await createEmailAccess({
      invoices: [invoice],
      phoneNormalized: phone,
      recipientEmail,
      req,
      purpose: "invoice-delivery",
      firebaseUid: req.invoiceAccess.firebaseUid,
      notificationLogId: pendingLog._id,
    });
    return res.status(202).json({
      success: true,
      message: "Invoice emailed successfully.",
      maskedRecipientEmail: maskEmail(email),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "We could not send the invoice right now",
    });
  }
};

const whatsappStatusById = async (req, res) => {
  const { id } = req.params;
  if (!invoiceIdIsAllowed(id, req.invoiceAccess)) {
    return res
      .status(404)
      .json({ success: false, message: "Invoice not found" });
  }
  const invoice = await AquaInvoice.findById(id).lean();
  if (!invoice || !canReadInvoice(invoice, req.invoiceAccess)) {
    return res.status(403).json({
      success: false,
      message: "Confirm this invoice before sharing it",
    });
  }
  return res.status(200).json({
    success: true,
    whatsapp: getWhatsAppInvoiceSharingStatus(),
  });
};

export default {
  lookup,
  requestAccess,
  exchange,
  loginAccess,
  loginDirectAccess,
  list,
  getById,
  claimById,
  updateEmailById,
  emailById,
  whatsappStatusById,
};
