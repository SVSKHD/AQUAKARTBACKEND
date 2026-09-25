import mongoose from "mongoose";
import WhatsAppConversation from "../../models/crm/whatsappConversation.js";
import WhatsAppMessage from "../../models/crm/whatsappMessage.js";
import { sendFast2SmsWhatsAppTemplate } from "../../services/notifications/fast2SmsWhatsApp.js";
import { recordOutboundWhatsAppMessage } from "../../services/crm/whatsappCrm.js";

const isValidObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(String(value || ""));

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^$()|[\]\\]/g, "\\$&");

const listConversations = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.unread === "true") filter.unread_count = { $gt: 0 };
    if (req.query.assigned_to && isValidObjectId(req.query.assigned_to)) {
      filter.assigned_to = req.query.assigned_to;
    }
    if (req.query.lead_id && isValidObjectId(req.query.lead_id)) {
      filter.lead_id = req.query.lead_id;
    }
    if (req.query.search) {
      const search = new RegExp(escapeRegex(req.query.search), "i");
      filter.$or = [
        { contact_name: search },
        { phone_normalized: search },
        { wa_id: search },
      ];
    }

    const [items, total] = await Promise.all([
      WhatsAppConversation.find(filter)
        .sort({ last_message_at: -1, updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate(
          "lead_id",
          "contact_name phone email status source score score_band qualification",
        )
        .populate("assigned_to", "firstName lastName email")
        .lean(),
      WhatsAppConversation.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    console.error("listConversations error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to list WhatsApp conversations",
    });
  }
};

const getConversation = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation id",
      });
    }

    const conversation = await WhatsAppConversation.findById(req.params.id)
      .populate(
        "lead_id",
        "contact_name phone email status source score score_band qualification intake_events next_follow_up",
      )
      .populate("assigned_to", "firstName lastName email");

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    return res.json({ success: true, data: conversation });
  } catch (error) {
    console.error("getConversation error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to load conversation",
    });
  }
};

const getMessages = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation id",
      });
    }

    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const filter = { conversation_id: req.params.id };

    const [messages, total] = await Promise.all([
      WhatsAppMessage.find(filter)
        .sort({ occurred_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("quotation_id", "quotationNo status totalAmount")
        .lean(),
      WhatsAppMessage.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: messages.reverse(),
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    console.error("getMessages error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to load WhatsApp messages",
    });
  }
};

const updateConversation = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation id",
      });
    }

    const update = {};
    if (["open", "closed", "archived"].includes(req.body?.status)) {
      update.status = req.body.status;
    }
    if (
      req.body?.assigned_to === null ||
      isValidObjectId(req.body?.assigned_to)
    ) {
      update.assigned_to = req.body.assigned_to || null;
    }
    if (Array.isArray(req.body?.tags)) {
      update.tags = req.body.tags
        .map((item) => String(item).trim())
        .filter(Boolean)
        .slice(0, 20);
    }
    if (req.body?.mark_read === true) {
      update.unread_count = 0;
    }

    const conversation = await WhatsAppConversation.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true },
    )
      .populate("lead_id", "contact_name phone email status score score_band")
      .populate("assigned_to", "firstName lastName email");

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    return res.json({ success: true, data: conversation });
  } catch (error) {
    console.error("updateConversation error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to update conversation",
    });
  }
};

const sendTemplateReply = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation id",
      });
    }

    const conversation = await WhatsAppConversation.findById(req.params.id)
      .populate("lead_id", "contact_name phone");
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    const messageId = String(req.body?.messageId || "").trim();
    if (!messageId) {
      return res.status(400).json({
        success: false,
        message: "Approved WhatsApp messageId is required",
      });
    }

    const variables = Array.isArray(req.body?.variables)
      ? req.body.variables.map(String)
      : [];

    const providerResult = await sendFast2SmsWhatsAppTemplate({
      to: conversation.phone_normalized,
      messageId,
      variables,
      mediaUrl: req.body?.mediaUrl,
      documentFilename: req.body?.documentFilename,
      udf: Array.isArray(req.body?.udf) ? req.body.udf : [],
    });

    const recorded = await recordOutboundWhatsAppMessage({
      to: conversation.phone_normalized,
      contactName:
        conversation.contact_name ||
        conversation.lead_id?.contact_name ||
        "",
      text: req.body?.previewText || "",
      templateId: messageId,
      variables,
      mediaUrl: req.body?.mediaUrl || "",
      providerResult,
      leadId: conversation.lead_id?._id || conversation.lead_id || null,
    });

    return res.status(200).json({
      success: true,
      data: recorded.message,
      provider: providerResult,
    });
  } catch (error) {
    console.error("sendTemplateReply error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message || "Unable to send WhatsApp reply",
      details: error.details,
    });
  }
};

export default {
  listConversations,
  getConversation,
  getMessages,
  updateConversation,
  sendTemplateReply,
};
