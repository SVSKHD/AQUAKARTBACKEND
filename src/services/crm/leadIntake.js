import mongoose from "mongoose";
import AquaLead from "../../models/crm/lead.js";
import AquaProduct from "../../models/product.js";
import { calculateLeadScore } from "../../utils/crmLeadScore.js";
import {
  normalizeEmail,
  normalizeIndianPhone,
  validateEmail,
} from "../../utils/invoiceAccess.js";

const EARLY_PIPELINE_STAGES = new Set(["new", "contacted", "qualified"]);

const cleanString = (value, max = 500) =>
  String(value || "").trim().slice(0, max);

const clampInt = (value, min = 0, max = 1000000) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.round(parsed)));
};

export const calculatePlannerCapacity = ({
  residents = "",
  coverage = "",
  hardness = "",
} = {}) => {
  if (coverage === "bathroom") return hardness === "very-hard" ? 12 : 8;

  const peopleBase = {
    "1-2": 20,
    "3-4": 25,
    "5-7": 40,
    "8+": 100,
  }[residents] || 25;

  const coverageBoost = coverage === "whole-home" ? 1.25 : 1;
  const hardnessBoost =
    hardness === "very-hard" ? 1.25 : hardness === "unknown" ? 1.1 : 1;

  return Math.ceil(peopleBase * coverageBoost * hardnessBoost);
};

const residentsNumeric = (range = "") =>
  ({
    "1-2": 2,
    "3-4": 4,
    "5-7": 7,
    "8+": 8,
  })[range] || null;

const hardnessLevel = (value = "") =>
  ({
    mild: "mild",
    hard: "hard",
    "very-hard": "very_hard",
    unknown: "unknown",
  })[value] || "";

const interestFromCoverage = (value = "") =>
  ({
    bathroom: "bathroom",
    multiple: "automatic",
    "whole-home": "whole_house",
  })[value] || "";

export const buildPlannerQualification = ({
  answers = {},
  requiredCapacityLiters,
  recommendedProduct,
} = {}) => ({
  residents: residentsNumeric(answers.residents),
  residents_range: cleanString(answers.residents, 20),
  coverage: ["bathroom", "multiple", "whole-home"].includes(answers.coverage)
    ? answers.coverage
    : "",
  hardness_level: hardnessLevel(answers.hardness),
  product_interest: interestFromCoverage(answers.coverage),
  recommended_capacity_liters:
    clampInt(
      requiredCapacityLiters ??
        calculatePlannerCapacity({
          residents: answers.residents,
          coverage: answers.coverage,
          hardness: answers.hardness,
        }),
      0,
      10000,
    ) || null,
  recommended_product_id: cleanString(recommendedProduct?.product_id, 100),
  recommended_product_name: cleanString(recommendedProduct?.title, 200),
});

export const resolveProductContext = async ({
  productId,
  slug,
  url = "",
} = {}) => {
  const or = [];
  if (productId && mongoose.Types.ObjectId.isValid(String(productId))) {
    or.push({ _id: productId });
  }
  if (slug) {
    or.push({ slug: String(slug).trim() }, { seoSlug: String(slug).trim() });
  }
  if (!or.length) return null;

  const product = await AquaProduct.findOne({ $or: or })
    .select("_id title slug seoSlug price")
    .lean();

  if (!product) return null;

  return {
    product_id: String(product._id),
    title: product.title || "",
    slug: product.slug || product.seoSlug || "",
    url: cleanString(url, 1000),
    price: Number(product.price) || null,
  };
};

const normalizedIdentity = ({ phone, email } = {}) => {
  const phoneNormalized = normalizeIndianPhone(phone);
  const emailNormalized = validateEmail(email) || "";
  return {
    phone_normalized: phoneNormalized,
    email_normalized: emailNormalized,
  };
};

export const findLeadByIdentity = async ({ phone, email } = {}) => {
  const { phone_normalized, email_normalized } = normalizedIdentity({
    phone,
    email,
  });

  const or = [];
  if (phone_normalized) {
    or.push({ phone_normalized });
    or.push({ phone: phone_normalized });
    or.push({ phone: `91${phone_normalized}` });
    or.push({ phone: `+91${phone_normalized}` });
  }
  if (email_normalized) {
    or.push({ email_normalized });
    or.push({ email: email_normalized });
  }
  if (!or.length) return { lead: null, matchedBy: "" };

  const lead = await AquaLead.findOne({ $or: or }).sort({ updated_at: -1 });
  if (!lead) return { lead: null, matchedBy: "" };

  const matchedBy =
    phone_normalized &&
    [lead.phone_normalized, normalizeIndianPhone(lead.phone)].includes(
      phone_normalized,
    )
      ? "phone"
      : "email";

  return { lead, matchedBy };
};

const mergeQualification = (current, incoming = {}) => {
  const existing =
    current && typeof current.toObject === "function"
      ? current.toObject()
      : current || {};
  const merged = { ...existing };

  Object.entries(incoming || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  });

  return merged;
};

const pushIntakeEvent = (lead, event) => {
  lead.intake_events.push(event);
  if (lead.intake_events.length > 100) {
    lead.intake_events = lead.intake_events.slice(-100);
  }
  lead.last_intake_channel = event.channel;
  lead.last_intake_at = event.submitted_at || new Date();
};

const applyScore = (lead) => {
  const result = calculateLeadScore(lead.toObject());
  lead.score = result.score;
  lead.score_band = result.band;
  lead.score_breakdown = result.breakdown;
  lead.score_updated_at = new Date();
};

const maybeAdvanceStage = (lead, channel) => {
  let nextStatus = lead.status;

  if (channel === "planner" && EARLY_PIPELINE_STAGES.has(lead.status)) {
    nextStatus = "water_details";
  } else if (channel === "whatsapp" && lead.status === "new") {
    nextStatus = "contacted";
  }

  if (nextStatus !== lead.status) {
    lead.stage_history.push({
      from: lead.status,
      to: nextStatus,
      changed_by: null,
      note: `Automatically advanced from ${channel} intake`,
    });
    lead.status = nextStatus;
  }
};

export const upsertLeadFromIntake = async ({
  channel,
  contact = {},
  source = "",
  page = {},
  message = "",
  qualification = {},
  planner = {},
  product = null,
  rawContext = {},
} = {}) => {
  const contactName = cleanString(contact.name, 200);
  const phone = cleanString(contact.phone, 30);
  const email = normalizeEmail(contact.email);
  const { phone_normalized, email_normalized } = normalizedIdentity({
    phone,
    email,
  });

  if (!contactName) {
    const error = new Error("Contact name is required");
    error.statusCode = 400;
    throw error;
  }
  if (!phone_normalized && !email_normalized) {
    const error = new Error("A valid Indian phone number or email is required");
    error.statusCode = 400;
    throw error;
  }

  const { lead: existing, matchedBy } = await findLeadByIdentity({
    phone,
    email,
  });

  const lead =
    existing ||
    new AquaLead({
      contact_name: contactName,
      phone: phone_normalized || phone,
      email: email_normalized,
      phone_normalized,
      email_normalized,
      company_name: cleanString(contact.company_name, 200) || "Individual",
      source: cleanString(source || channel, 100),
      status: channel === "whatsapp" ? "contacted" : "new",
    });

  if (!existing) {
    lead.stage_history.push({
      from: "",
      to: lead.status,
      changed_by: null,
      note: `Created from ${channel} intake`,
    });
  }

  lead.contact_name = contactName || lead.contact_name;
  if (phone_normalized) {
    lead.phone = phone_normalized;
    lead.phone_normalized = phone_normalized;
  }
  if (email_normalized) {
    lead.email = email_normalized;
    lead.email_normalized = email_normalized;
  }
  if (!lead.source) lead.source = cleanString(source || channel, 100);

  if (Object.keys(qualification || {}).length) {
    lead.qualification = mergeQualification(lead.qualification, qualification);
  }

  maybeAdvanceStage(lead, channel);

  const intakeEvent = {
    channel,
    source: cleanString(source || channel, 100),
    page_url: cleanString(page.url, 1000),
    page_path: cleanString(page.path, 500),
    referrer: cleanString(page.referrer, 1000),
    message: cleanString(message, 3000),
    product: product || undefined,
    planner: planner || undefined,
    raw_context:
      rawContext && typeof rawContext === "object" ? rawContext : {},
    submitted_at: new Date(),
  };

  pushIntakeEvent(lead, intakeEvent);
  applyScore(lead);
  await lead.save();

  return {
    lead,
    created: !existing,
    matchedBy: existing ? matchedBy : "",
    intakeEvent: lead.intake_events[lead.intake_events.length - 1],
  };
};
