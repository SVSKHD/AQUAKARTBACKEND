import WhatsAppConversation from "../../models/crm/whatsappConversation.js";
import WhatsAppMessage from "../../models/crm/whatsappMessage.js";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";
import {
  findLeadByIdentity,
  upsertLeadFromIntake,
} from "./leadIntake.js";

const asDate = (timestamp) => {
  if (!timestamp) return new Date();
  const asNumber = Number(timestamp);
  if (Number.isFinite(asNumber)) {
    const ms = asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const preview = (value = "") =>
  String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);

export const extractProviderMessageId = (result = {}) => {
  const data = result?.data || result || {};
  return String(
    data?.message_id ||
      data?.messageId ||
      data?.request_id ||
      data?.requestId ||
      data?.id ||
      data?.data?.message_id ||
      data?.data?.messageId ||
      data?.data?.request_id ||
      data?.data?.id ||
      "",
  ).trim();
};

export const getOrCreateConversation = async ({
  phone,
  waId = "",
  contactName = "",
  leadId = null,
} = {}) => {
  const phoneNormalized = normalizeIndianPhone(phone || waId);
  if (!phoneNormalized) {
    const error = new Error("A valid Indian WhatsApp number is required");
    error.statusCode = 400;
    throw error;
  }

  const conversation = await WhatsAppConversation.findOneAndUpdate(
    { phone_normalized: phoneNormalized },
    {
      $set: {
        ...(waId ? { wa_id: String(waId) } : {}),
        ...(contactName ? { contact_name: String(contactName).trim() } : {}),
        ...(leadId ? { lead_id: leadId } : {}),
      },
      $setOnInsert: {
        status: "open",
        unread_count: 0,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  return conversation;
};

export const recordIncomingWhatsAppEvent = async (event = {}) => {
  const phoneNormalized = normalizeIndianPhone(event.waId);
  if (!phoneNormalized) {
    return { status: "ignored", reason: "invalid_phone" };
  }

  if (event.messageId) {
    const existingMessage = await WhatsAppMessage.findOne({
      provider_message_id: event.messageId,
    });
    if (existingMessage) {
      return {
        status: "duplicate",
        message: existingMessage,
      };
    }
  }

  const contactName =
    String(event.contactName || "").trim() ||
    `WhatsApp ${phoneNormalized.slice(-4)}`;

  const intake = await upsertLeadFromIntake({
    channel: "whatsapp",
    contact: {
      name: contactName,
      phone: phoneNormalized,
    },
    source: "whatsapp",
    message: event.text || "",
    rawContext: {
      message_type: event.messageType || "unknown",
      phone_number_id: event.phoneNumberId || "",
    },
  });

  const conversation = await getOrCreateConversation({
    phone: phoneNormalized,
    waId: event.waId,
    contactName,
    leadId: intake.lead._id,
  });

  const occurredAt = asDate(event.timestamp);
  const message = await WhatsAppMessage.create({
    conversation_id: conversation._id,
    lead_id: intake.lead._id,
    direction: "inbound",
    provider: "meta",
    provider_message_id: event.messageId || "",
    provider_status: "received",
    status_history: [
      {
        status: "received",
        at: occurredAt,
        raw: event.raw || {},
      },
    ],
    phone_normalized: phoneNormalized,
    wa_id: event.waId || "",
    message_type: event.messageType || "unknown",
    text: event.text || "",
    raw: event.raw || {},
    occurred_at: occurredAt,
  });

  await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
    $set: {
      lead_id: intake.lead._id,
      contact_name: contactName,
      status: "open",
      last_message_at: occurredAt,
      last_message_direction: "inbound",
      last_message_preview: preview(event.text || event.messageType),
      last_inbound_at: occurredAt,
    },
    $inc: { unread_count: 1 },
  });

  return {
    status: "stored",
    conversationId: conversation._id,
    message,
    lead: intake.lead,
    leadCreated: intake.created,
  };
};

const normalizeProviderStatus = (status = "") => {
  const value = String(status || "").toLowerCase();
  if (["sent", "delivered", "read", "failed", "queued"].includes(value)) {
    return value;
  }
  return "unknown";
};

export const recordWhatsAppStatusEvent = async (event = {}) => {
  const providerStatus = normalizeProviderStatus(event.status);
  const occurredAt = asDate(event.timestamp);

  let message = event.messageId
    ? await WhatsAppMessage.findOne({
        provider_message_id: event.messageId,
      })
    : null;

  if (!message) {
    const phoneNormalized = normalizeIndianPhone(event.waId);
    if (!phoneNormalized) {
      return { status: "ignored", reason: "message_not_found" };
    }

    const { lead } = await findLeadByIdentity({ phone: phoneNormalized });
    const conversation = await getOrCreateConversation({
      phone: phoneNormalized,
      waId: event.waId,
      leadId: lead?._id || null,
    });

    message = await WhatsAppMessage.create({
      conversation_id: conversation._id,
      lead_id: lead?._id || null,
      direction: "outbound",
      provider: "meta",
      provider_message_id: event.messageId || "",
      provider_status: providerStatus,
      status_history: [
        {
          status: providerStatus,
          at: occurredAt,
          raw: event.raw || {},
        },
      ],
      phone_normalized: phoneNormalized,
      wa_id: event.waId || "",
      message_type: "unknown",
      error: event.errors || null,
      raw: event.raw || {},
      occurred_at: occurredAt,
    });

    return { status: "stored_orphan_status", message };
  }

  message.provider_status = providerStatus;
  message.error = event.errors || message.error;
  message.status_history.push({
    status: providerStatus,
    at: occurredAt,
    raw: event.raw || {},
  });
  await message.save();

  return { status: "updated", message };
};

export const recordOutboundWhatsAppMessage = async ({
  to,
  contactName = "",
  text = "",
  templateId = "",
  variables = [],
  mediaUrl = "",
  providerResult = {},
  quotationId = null,
  leadId = null,
} = {}) => {
  const phoneNormalized = normalizeIndianPhone(to);
  if (!phoneNormalized) {
    const error = new Error("A valid Indian WhatsApp number is required");
    error.statusCode = 400;
    throw error;
  }

  let resolvedLeadId = leadId;
  if (!resolvedLeadId) {
    const match = await findLeadByIdentity({ phone: phoneNormalized });
    resolvedLeadId = match.lead?._id || null;
  }

  const conversation = await getOrCreateConversation({
    phone: phoneNormalized,
    contactName,
    leadId: resolvedLeadId,
  });

  const providerMessageId = extractProviderMessageId(providerResult);
  const occurredAt = new Date();

  let message =
    providerMessageId &&
    (await WhatsAppMessage.findOne({
      provider_message_id: providerMessageId,
    }));

  if (message) {
    message.conversation_id = conversation._id;
    message.lead_id = resolvedLeadId;
    message.quotation_id = quotationId;
    message.direction = "outbound";
    message.provider = "fast2sms";
    message.provider_status = "sent";
    message.message_type = "template";
    message.text = text;
    message.template_id = String(templateId || "");
    message.variables = variables.map(String);
    message.media_url = String(mediaUrl || "");
    message.raw = providerResult?.data || providerResult || {};
    message.occurred_at = occurredAt;
    message.status_history.push({ status: "sent", at: occurredAt });
    await message.save();
  } else {
    message = await WhatsAppMessage.create({
      conversation_id: conversation._id,
      lead_id: resolvedLeadId,
      quotation_id: quotationId,
      direction: "outbound",
      provider: "fast2sms",
      provider_message_id: providerMessageId,
      provider_status: "sent",
      status_history: [{ status: "sent", at: occurredAt }],
      phone_normalized: phoneNormalized,
      message_type: "template",
      text,
      template_id: String(templateId || ""),
      variables: variables.map(String),
      media_url: String(mediaUrl || ""),
      raw: providerResult?.data || providerResult || {},
      occurred_at: occurredAt,
    });
  }

  await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
    $set: {
      ...(resolvedLeadId ? { lead_id: resolvedLeadId } : {}),
      ...(contactName ? { contact_name: contactName } : {}),
      last_message_at: occurredAt,
      last_message_direction: "outbound",
      last_message_preview: preview(text || `Template ${templateId}`),
      last_outbound_at: occurredAt,
    },
  });

  return { conversation, message };
};
