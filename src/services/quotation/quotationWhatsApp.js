import { sendFast2SmsWhatsAppTemplate } from "../notifications/fast2SmsWhatsApp.js";
import {
  extractProviderMessageId,
  recordOutboundWhatsAppMessage,
} from "../crm/whatsappCrm.js";
import { buildQuotationViewLinks } from "../../utils/invoiceViews.js";
import AquaLead from "../../models/crm/lead.js";
import { calculateLeadScore } from "../../utils/crmLeadScore.js";
import {
  findLeadByIdentity,
  upsertLeadFromIntake,
} from "../crm/leadIntake.js";

const TERMINAL_QUOTATION_STATUSES = new Set([
  "Accepted",
  "Rejected",
  "Expired",
  "Paid",
  "Converted",
]);

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getQuotationWhatsAppTemplateId = (followUp = false) =>
  followUp
    ? process.env.FAST2SMS_WHATSAPP_QUOTATION_FOLLOWUP_MESSAGE_ID || ""
    : process.env.FAST2SMS_WHATSAPP_QUOTATION_MESSAGE_ID || "";

const PIPELINE_ORDER = [
  "new",
  "contacted",
  "qualified",
  "water_details",
  "site_visit",
  "recommended",
  "quote_sent",
  "follow_up",
  "won",
  "lost",
];

const ensureQuotationLead = async (quotation) => {
  let lead = quotation.lead
    ? await AquaLead.findById(quotation.lead)
    : null;

  if (!lead) {
    const matched = await findLeadByIdentity({
      phone: quotation.customerDetails?.phone,
      email: quotation.customerDetails?.email,
    });
    lead = matched.lead;
  }

  if (!lead) {
    const intake = await upsertLeadFromIntake({
      channel: "whatsapp",
      contact: {
        name: quotation.customerDetails?.name || "Quotation Customer",
        phone: quotation.customerDetails?.phone,
        email: quotation.customerDetails?.email,
      },
      source: "quotation_whatsapp",
      message: `Quotation ${quotation.quotationNo || ""} prepared`,
      rawContext: {
        quotation_id: String(quotation._id),
      },
    });
    lead = intake.lead;
  }

  quotation.lead = lead._id;
  return lead;
};

const advanceLeadToStage = async (lead, targetStatus, note) => {
  if (!lead || ["won", "lost"].includes(lead.status)) return lead;

  const currentIndex = PIPELINE_ORDER.indexOf(lead.status);
  const targetIndex = PIPELINE_ORDER.indexOf(targetStatus);
  if (targetIndex < 0 || currentIndex >= targetIndex) return lead;

  const previous = lead.status;
  lead.status = targetStatus;
  lead.stage_history.push({
    from: previous,
    to: targetStatus,
    changed_by: null,
    note,
  });

  const score = calculateLeadScore(lead.toObject());
  lead.score = score.score;
  lead.score_band = score.band;
  lead.score_breakdown = score.breakdown;
  lead.score_updated_at = new Date();
  await lead.save();
  return lead;
};

const quotationVariables = (quotation) => {
  const links = buildQuotationViewLinks(quotation._id);
  return [
    quotation.customerDetails?.name || "Customer",
    quotation.quotationNo || "Quotation",
    String(Number(quotation.totalAmount || 0).toFixed(0)),
    links.customerUrl,
  ];
};

export const stopQuotationFollowUps = async (
  quotation,
  { now = new Date(), save = true } = {},
) => {
  quotation.whatsapp.followUpEnabled = false;
  quotation.whatsapp.nextFollowUpAt = null;
  quotation.whatsapp.followUpLockUntil = null;
  quotation.whatsapp.stoppedAt = now;
  if (save) await quotation.save();
  return quotation;
};

export const sendQuotationWhatsApp = async ({
  quotation,
  followUp = false,
  messageId,
  variables,
  now = new Date(),
} = {}) => {
  if (!quotation) {
    const error = new Error("Quotation is required");
    error.statusCode = 400;
    throw error;
  }

  if (TERMINAL_QUOTATION_STATUSES.has(quotation.status)) {
    await stopQuotationFollowUps(quotation, { now });
    return {
      skipped: true,
      reason: "terminal_status",
      quotation,
    };
  }

  const to = quotation.customerDetails?.phone;
  if (!to) {
    const error = new Error("Quotation customer phone is required");
    error.statusCode = 400;
    throw error;
  }

  const resolvedMessageId =
    String(messageId || getQuotationWhatsAppTemplateId(followUp)).trim();
  if (!resolvedMessageId) {
    const error = new Error(
      followUp
        ? "FAST2SMS_WHATSAPP_QUOTATION_FOLLOWUP_MESSAGE_ID is not configured"
        : "FAST2SMS_WHATSAPP_QUOTATION_MESSAGE_ID is not configured",
    );
    error.code = "QUOTATION_WHATSAPP_TEMPLATE_MISSING";
    error.statusCode = 503;
    throw error;
  }

  const lead = await ensureQuotationLead(quotation);

  const resolvedVariables = Array.isArray(variables)
    ? variables.map(String)
    : quotationVariables(quotation);

  const links = buildQuotationViewLinks(quotation._id);
  const providerResult = await sendFast2SmsWhatsAppTemplate({
    to,
    messageId: resolvedMessageId,
    variables: resolvedVariables,
    udf: [
      String(quotation._id),
      quotation.quotationNo || "",
      followUp ? "quotation-followup" : "quotation",
    ],
  });

  const recorded = await recordOutboundWhatsAppMessage({
    to,
    contactName: quotation.customerDetails?.name || "",
    text: `${followUp ? "Follow-up: " : ""}Quotation ${quotation.quotationNo || ""} — ${links.customerUrl}`,
    templateId: resolvedMessageId,
    variables: resolvedVariables,
    providerResult,
    quotationId: quotation._id,
    leadId: lead?._id || quotation.lead || null,
  });

  const providerMessageId =
    extractProviderMessageId(providerResult) ||
    String(recorded.message?.provider_message_id || "");

  quotation.whatsapp.lastSentAt = now;
  quotation.whatsapp.lastMessageId = providerMessageId;
  quotation.whatsapp.followUpLockUntil = null;

  if (followUp) {
    await advanceLeadToStage(
      lead,
      "follow_up",
      `Quotation ${quotation.quotationNo || ""} follow-up sent on WhatsApp`,
    );
    quotation.whatsapp.followUpCount =
      Number(quotation.whatsapp.followUpCount || 0) + 1;
    quotation.whatsapp.lastFollowUpAt = now;
    quotation.whatsapp.lastFollowUpError = "";

    const maxFollowUps = number(quotation.whatsapp.maxFollowUps, 3);
    if (quotation.whatsapp.followUpCount >= maxFollowUps) {
      quotation.whatsapp.followUpEnabled = false;
      quotation.whatsapp.nextFollowUpAt = null;
      quotation.whatsapp.stoppedAt = now;
    } else {
      const intervalHours = number(
        quotation.whatsapp.followUpIntervalHours,
        24,
      );
      quotation.whatsapp.followUpEnabled = true;
      quotation.whatsapp.nextFollowUpAt = new Date(
        now.getTime() + intervalHours * 60 * 60 * 1000,
      );
    }
  } else {
    quotation.whatsapp.initialSentAt =
      quotation.whatsapp.initialSentAt || now;
    quotation.whatsapp.sendCount =
      Number(quotation.whatsapp.sendCount || 0) + 1;
    quotation.whatsapp.followUpCount =
      Number(quotation.whatsapp.followUpCount || 0);
    quotation.whatsapp.followUpEnabled = true;
    quotation.whatsapp.stoppedAt = null;

    const intervalHours = number(
      quotation.whatsapp.followUpIntervalHours,
      number(process.env.QUOTATION_FOLLOWUP_INTERVAL_HOURS, 24),
    );
    quotation.whatsapp.followUpIntervalHours = intervalHours;
    quotation.whatsapp.maxFollowUps = number(
      quotation.whatsapp.maxFollowUps,
      number(process.env.QUOTATION_MAX_FOLLOWUPS, 3),
    );
    quotation.whatsapp.nextFollowUpAt = new Date(
      now.getTime() + intervalHours * 60 * 60 * 1000,
    );

    if (quotation.status === "Draft") quotation.status = "Sent";
    await advanceLeadToStage(
      lead,
      "quote_sent",
      `Quotation ${quotation.quotationNo || ""} sent on WhatsApp`,
    );
  }

  await quotation.save();

  return {
    success: true,
    providerResult,
    message: recorded.message,
    conversation: recorded.conversation,
    quotation,
    links,
  };
};

export { TERMINAL_QUOTATION_STATUSES };
