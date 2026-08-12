import mongoose from "mongoose";
import AquaInvoice from "../../models/crm/invoice.js";
import NotificationLog from "../../models/crm/notificationLog.js";
import sendEmail from "../../notifications/email/send-email.js";
import crmInvoiceDeliveryEmail from "../../utils/emailTemplates/crmInvoiceDeliveryEmail.js";
import { buildInvoiceViewLinks } from "../../utils/invoiceViews.js";

const maskEmail = (email) => {
  const [localPart, domain] = String(email || "").split("@");
  if (!localPart || !domain) return "";
  return `${localPart.slice(0, 2)}***@${domain}`;
};

const sendInvoiceEmail = async (req, res) => {
  let log;

  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid invoice id" });
    }

    const invoice = await AquaInvoice.findById(id).lean();
    if (!invoice) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const email = String(invoice.customerDetails?.email || "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invoice does not have a valid customer email",
      });
    }

    const links = buildInvoiceViewLinks(invoice._id);
    const storedTotal = invoice.total_price ?? invoice.totalPrice;
    const invoiceTotal = Number.isFinite(Number(storedTotal))
      ? new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: "INR",
          maximumFractionDigits: 2,
        }).format(Number(storedTotal))
      : undefined;
    const content = crmInvoiceDeliveryEmail({
      customerName: invoice.customerDetails?.name,
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.date,
      invoiceTotal,
      invoiceUrl: links.customerUrl,
    });

    log = await NotificationLog.create({
      invoiceId: invoice._id,
      channel: "email",
      recipientMasked: maskEmail(email),
      template: "crm-invoice-delivery",
      message: `Invoice email ${invoice.invoiceNo || invoice._id}`,
      status: "pending",
    });

    const delivery = await sendEmail({
      email,
      subject: content.subject,
      message: content.text,
      content: content.html,
    });

    if (!delivery.success) {
      await NotificationLog.findByIdAndUpdate(log._id, {
        $set: {
          status: "failed",
          errorCode: delivery.code || "EMAIL_DELIVERY_FAILED",
          response: delivery.message,
        },
      });
      return res.status(503).json({
        success: false,
        message: delivery.message || "Failed to email invoice",
      });
    }

    await NotificationLog.findByIdAndUpdate(log._id, {
      $set: {
        status: "sent",
        providerMessageId: delivery.messageId,
      },
    });

    return res.status(202).json({
      success: true,
      message: "Invoice emailed successfully.",
      maskedRecipientEmail: maskEmail(email),
    });
  } catch (error) {
    if (log?._id) {
      await NotificationLog.findByIdAndUpdate(log._id, {
        $set: {
          status: "failed",
          errorCode: error.code || "EMAIL_DELIVERY_FAILED",
          response: "Email delivery failed",
        },
      });
    }
    return res.status(500).json({
      success: false,
      message: "We could not email the invoice right now",
    });
  }
};

export default { sendInvoiceEmail };
