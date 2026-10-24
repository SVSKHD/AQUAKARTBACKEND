import { runUnenrichedInvoiceReminder } from "../../jobs/unenrichedInvoiceReminder.js";
import { runProductServiceReminders } from "../../jobs/productServiceReminders.js";
import { runQuotationFollowUps } from "../../jobs/quotationFollowups.js";
import { runAiBlogDrafts } from "../../jobs/aiBlogDrafts.js";
import { runAiSeoRefresh } from "../../jobs/aiSeoRefresh.js";
import sendWhatsAppMessage from "../../utils/sendWhatsApp.js";
import sendEmail from "../../notifications/email/send-email.js";
import { generateContent } from "../gemini.js";

// Everything a scheduled job can do. The CRM picks an action and supplies
// params; it can never run arbitrary code. `systemOnly` actions back the
// built-in jobs and cannot be attached to new jobs (avoids duplicate sends).

const MAX_RECIPIENTS = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sendToRecipients = async (recipients, send) => {
  const failures = [];
  let sent = 0;
  for (const recipient of recipients) {
    const result = await send(recipient);
    if (result?.success) sent += 1;
    else failures.push({ recipient, message: result?.message || "Failed" });
  }
  if (sent === 0 && failures.length) {
    const error = new Error(`All ${failures.length} deliveries failed`);
    error.result = { sent, failed: failures.length, failures };
    throw error;
  }
  return { sent, failed: failures.length, failures };
};

const notify = async ({ text, subject, whatsappTo = [], emailTo = [] }) => {
  const result = {};
  if (whatsappTo.length) {
    result.whatsapp = await sendToRecipients(whatsappTo, (to) =>
      sendWhatsAppMessage(to, text),
    );
  }
  if (emailTo.length) {
    result.email = await sendToRecipients(emailTo, (email) =>
      sendEmail({ email, subject, message: text }),
    );
  }
  return result;
};

export const ACTIONS = {
  "invoice.unenriched_reminder": {
    label: "Unenriched invoice reminder",
    description:
      "Emails/notifies staff about invoices missing customer enrichment.",
    systemOnly: true,
    params: [],
    run: ({ now }) => runUnenrichedInvoiceReminder(now),
  },
  "service.product_reminders": {
    label: "Product service reminders",
    description:
      "Sends due service and warranty reminders to customers for purchased products.",
    systemOnly: true,
    params: [],
    run: ({ now }) => runProductServiceReminders(now),
  },
  "quotation.followups": {
    label: "Quotation WhatsApp follow-ups",
    description: "Sends due WhatsApp follow-ups for open quotations.",
    systemOnly: true,
    params: [],
    run: ({ now }) => runQuotationFollowUps(now),
  },
  "blog.ai_drafts": {
    label: "AI blog drafts",
    description:
      "Writes SEO-ready blog posts with Gemini and saves them as drafts without images for staff review.",
    systemOnly: true,
    params: [],
    run: ({ now }) => runAiBlogDrafts(now),
  },
  "seo.ai_refresh": {
    label: "AI SEO refresh",
    description:
      "Rewrites SEO titles, meta descriptions and keywords with Gemini in small batches, softener pages first; skips locked or recently hand-edited pages.",
    systemOnly: true,
    params: [
      {
        name: "batchSize",
        type: "number",
        label: "Pages per AI call (1-20)",
      },
      {
        name: "maxBatches",
        type: "number",
        label: "AI calls per run (1-10)",
      },
      {
        name: "focus",
        type: "string",
        label: "Focus (e.g. water softeners Hyderabad)",
        max: 200,
      },
    ],
    run: ({ now, params }) => runAiSeoRefresh(now, { params }),
  },
  "whatsapp.send": {
    label: "Send WhatsApp message",
    description: "Sends a fixed WhatsApp message to one or more numbers.",
    params: [
      {
        name: "to",
        type: "phone[]",
        label: "Phone numbers",
        required: true,
        max: MAX_RECIPIENTS,
      },
      {
        name: "message",
        type: "text",
        label: "Message",
        required: true,
        max: 4000,
      },
    ],
    run: ({ params }) =>
      notify({ text: params.message, whatsappTo: params.to }),
  },
  "email.send": {
    label: "Send email",
    description: "Sends an email to one or more addresses.",
    params: [
      {
        name: "to",
        type: "email[]",
        label: "Email addresses",
        required: true,
        max: MAX_RECIPIENTS,
      },
      {
        name: "subject",
        type: "string",
        label: "Subject",
        required: true,
        max: 200,
      },
      {
        name: "message",
        type: "text",
        label: "Message",
        required: true,
        max: 20000,
      },
    ],
    run: ({ params }) =>
      notify({
        text: params.message,
        subject: params.subject,
        emailTo: params.to,
      }),
  },
  "ai.generate_and_notify": {
    label: "AI generate and send",
    description:
      "Generates text with Gemini (e.g. a daily tip or summary) and sends it via WhatsApp and/or email.",
    params: [
      {
        name: "prompt",
        type: "text",
        label: "Prompt",
        required: true,
        max: 10000,
      },
      {
        name: "systemInstruction",
        type: "text",
        label: "System instruction",
        max: 5000,
      },
      {
        name: "whatsappTo",
        type: "phone[]",
        label: "WhatsApp numbers",
        max: MAX_RECIPIENTS,
      },
      {
        name: "emailTo",
        type: "email[]",
        label: "Email addresses",
        max: MAX_RECIPIENTS,
      },
      {
        name: "subject",
        type: "string",
        label: "Email subject",
        max: 200,
      },
    ],
    validate: (params) =>
      params.whatsappTo?.length || params.emailTo?.length
        ? null
        : "Provide at least one WhatsApp number or email address",
    run: async ({ params }) => {
      const generated = await generateContent({
        prompt: params.prompt,
        systemInstruction: params.systemInstruction,
        maxOutputTokens: 2048,
      });
      const delivery = await notify({
        text: generated.text,
        subject: params.subject || "AquaKart update",
        whatsappTo: params.whatsappTo || [],
        emailTo: params.emailTo || [],
      });
      return { text: generated.text, model: generated.model, ...delivery };
    },
  },
};

const toList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[,\n]/);
  return [];
};

const PARAM_PARSERS = {
  string: (value) => (typeof value === "string" ? value.trim() : undefined),
  text: (value) => (typeof value === "string" ? value.trim() : undefined),
  number: (value) =>
    Number.isFinite(Number(value)) ? Number(value) : undefined,
  boolean: (value) => (typeof value === "boolean" ? value : undefined),
  "phone[]": (value) =>
    toList(value)
      .map((item) => String(item).trim())
      .filter(Boolean),
  "email[]": (value) =>
    toList(value)
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean),
};

const ITEM_CHECKS = {
  "phone[]": (item) => /^(91)?\d{10}$/.test(item.replace(/\D/g, "")),
  "email[]": (item) => EMAIL_PATTERN.test(item),
};

// Returns { params, error } with params coerced to the action's declared types.
export const validateActionParams = (actionKey, input = {}) => {
  const action = ACTIONS[actionKey];
  if (!action) return { error: `Unknown action "${actionKey}"` };
  const source = input && typeof input === "object" ? input : {};
  const params = {};

  for (const spec of action.params) {
    const raw = source[spec.name];
    const value =
      raw === undefined || raw === null || raw === ""
        ? undefined
        : PARAM_PARSERS[spec.type](raw);
    const empty =
      value === undefined || (Array.isArray(value) && value.length === 0);

    if (empty) {
      if (spec.required) return { error: `${spec.label} is required` };
      continue;
    }
    if (raw !== undefined && value === undefined) {
      return { error: `${spec.label} has an invalid value` };
    }
    if (spec.max && (typeof value === "string" || Array.isArray(value))) {
      if (value.length > spec.max) {
        return {
          error: `${spec.label} allows at most ${spec.max} ${
            Array.isArray(value) ? "entries" : "characters"
          }`,
        };
      }
    }
    const check = ITEM_CHECKS[spec.type];
    const invalid = check && value.find((item) => !check(item));
    if (invalid) return { error: `${spec.label}: "${invalid}" is not valid` };

    params[spec.name] = value;
  }

  const error = action.validate?.(params);
  return error ? { error } : { params };
};

export const describeActions = () =>
  Object.entries(ACTIONS).map(([key, action]) => ({
    key,
    label: action.label,
    description: action.description,
    systemOnly: Boolean(action.systemOnly),
    params: action.params,
  }));
