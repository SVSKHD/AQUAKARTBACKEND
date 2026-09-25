import mongoose from "mongoose";

const LEAD_STATUSES = [
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
const LEAD_PAYMENT_STATUSES = ["pending", "cod", "paid"];
const LEAD_LOST_REASONS = [
  "price",
  "competitor",
  "no_response",
  "postponed",
  "unsuitable",
  "location",
  "budget",
  "duplicate",
  "other",
];
const FOLLOW_UP_STATUSES = ["scheduled", "completed", "cancelled", "missed"];
const WATER_SOURCES = ["borewell", "municipal", "tanker", "mixed", "unknown", ""];
const HARDNESS_LEVELS = ["mild", "hard", "very_hard", "unknown", ""];
const PRODUCT_INTERESTS = [
  "manual",
  "automatic",
  "whole_house",
  "bathroom",
  "unknown",
  "",
];
const LEAD_URGENCY = ["immediate", "7_days", "30_days", "researching", "unknown", ""];
const LEAD_INTAKE_CHANNELS = ["planner", "website", "product", "whatsapp", "manual"];

const stageHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: "" },
    to: { type: String, required: true },
    changed_at: { type: Date, default: Date.now },
    changed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
    },
    note: { type: String, trim: true, default: "" },
  },
  { _id: true },
);

const followUpSchema = new mongoose.Schema(
  {
    scheduled_for: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: FOLLOW_UP_STATUSES,
      default: "scheduled",
      index: true,
    },
    note: { type: String, trim: true, default: "" },
    reminder_at: { type: Date, default: null, index: true },
    reminder_sent_at: { type: Date, default: null },
    reminder_status: {
      type: String,
      enum: ["pending", "sent", "skipped"],
      default: "pending",
    },
    created_at: { type: Date, default: Date.now },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
    },
    completed_at: { type: Date, default: null },
    completed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
    },
  },
  { _id: true },
);

const intakeEventSchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: LEAD_INTAKE_CHANNELS,
      required: true,
      index: true,
    },
    source: { type: String, trim: true, default: "" },
    page_url: { type: String, trim: true, default: "" },
    page_path: { type: String, trim: true, default: "" },
    referrer: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },
    product: {
      product_id: { type: String, trim: true, default: "" },
      title: { type: String, trim: true, default: "" },
      slug: { type: String, trim: true, default: "" },
      url: { type: String, trim: true, default: "" },
      price: { type: Number, default: null },
    },
    planner: {
      residents: { type: String, trim: true, default: "" },
      coverage: { type: String, trim: true, default: "" },
      hardness: { type: String, trim: true, default: "" },
      required_capacity_liters: { type: Number, default: null },
      recommendation_product_ids: [{ type: String }],
      recommendation_product_names: [{ type: String }],
    },
    raw_context: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    submitted_at: { type: Date, default: Date.now, index: true },
  },
  { _id: true },
);

const leadSchema = new mongoose.Schema(
  {
    company_name: {
      type: String,
      trim: true,
      default: "Individual",
    },
    contact_name: {
      type: String,
      required: [true, "Contact name is required"],
      trim: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    phone_normalized: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    email_normalized: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      index: true,
    },
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: "new",
      index: true,
    },
    stage_history: {
      type: [stageHistorySchema],
      default: [],
    },
    source: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    last_intake_channel: {
      type: String,
      enum: [...LEAD_INTAKE_CHANNELS, ""],
      default: "",
      index: true,
    },
    last_intake_at: {
      type: Date,
      default: null,
      index: true,
    },
    intake_events: {
      type: [intakeEventSchema],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    payment_status: {
      type: String,
      enum: LEAD_PAYMENT_STATUSES,
      default: "pending",
      index: true,
    },
    customer_id: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    customer_type: {
      type: String,
      enum: ["online", "offline", ""],
      default: "",
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
      index: true,
    },
    next_follow_up: {
      type: Date,
      default: null,
      index: true,
    },
    follow_ups: {
      type: [followUpSchema],
      default: [],
    },
    qualification: {
      locality: { type: String, trim: true, default: "", index: true },
      pincode: { type: String, trim: true, default: "", index: true },
      water_source: {
        type: String,
        enum: WATER_SOURCES,
        default: "",
      },
      hardness_ppm: {
        type: Number,
        min: [0, "Hardness cannot be negative"],
        default: null,
      },
      hardness_level: {
        type: String,
        enum: HARDNESS_LEVELS,
        default: "",
      },
      bathrooms: {
        type: Number,
        min: [0, "Bathrooms cannot be negative"],
        default: null,
      },
      residents: {
        type: Number,
        min: [0, "Residents cannot be negative"],
        default: null,
      },
      residents_range: { type: String, trim: true, default: "" },
      coverage: {
        type: String,
        enum: ["bathroom", "multiple", "whole-home", ""],
        default: "",
      },
      budget_min: {
        type: Number,
        min: [0, "Budget cannot be negative"],
        default: null,
      },
      budget_max: {
        type: Number,
        min: [0, "Budget cannot be negative"],
        default: null,
      },
      product_interest: {
        type: String,
        enum: PRODUCT_INTERESTS,
        default: "",
      },
      urgency: {
        type: String,
        enum: LEAD_URGENCY,
        default: "",
      },
      water_problem: { type: String, trim: true, default: "" },
      recommended_capacity_liters: {
        type: Number,
        min: [0, "Recommended capacity cannot be negative"],
        default: null,
      },
      recommended_product_id: {
        type: String,
        trim: true,
        default: "",
      },
      recommended_product_name: {
        type: String,
        trim: true,
        default: "",
      },
    },
    lost_reason: {
      category: {
        type: String,
        enum: [...LEAD_LOST_REASONS, ""],
        default: "",
      },
      details: { type: String, trim: true, default: "" },
      competitor: { type: String, trim: true, default: "" },
      lost_at: { type: Date, default: null },
      lost_by: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AquaAdminUser",
        default: null,
      },
    },
    score: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
      index: true,
    },
    score_band: {
      type: String,
      enum: ["cold", "warm", "hot"],
      default: "cold",
      index: true,
    },
    score_breakdown: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    score_updated_at: {
      type: Date,
      default: null,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

leadSchema.index({
  company_name: "text",
  contact_name: "text",
  email: "text",
  phone: "text",
  source: "text",
  "qualification.locality": "text",
  "qualification.pincode": "text",
});

leadSchema.index({ status: 1, score: -1, next_follow_up: 1 });
leadSchema.index({ phone_normalized: 1, email_normalized: 1 });
leadSchema.index({ last_intake_channel: 1, last_intake_at: -1 });

const AquaLead =
  mongoose.models.AquaLead || mongoose.model("AquaLead", leadSchema);

export {
  LEAD_STATUSES,
  LEAD_PAYMENT_STATUSES,
  LEAD_LOST_REASONS,
  FOLLOW_UP_STATUSES,
  WATER_SOURCES,
  HARDNESS_LEVELS,
  PRODUCT_INTERESTS,
  LEAD_URGENCY,
  LEAD_INTAKE_CHANNELS,
};
export default AquaLead;
