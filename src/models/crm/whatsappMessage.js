import mongoose from "mongoose";

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const whatsappMessageSchema = new mongoose.Schema(
  {
    conversation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppConversation",
      required: true,
      index: true,
    },
    lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaLead",
      default: null,
      index: true,
    },
    quotation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaQuotation",
      default: null,
      index: true,
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ["meta", "fast2sms"],
      required: true,
      index: true,
    },
    provider_message_id: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
    },
    provider_status: {
      type: String,
      enum: [
        "received",
        "queued",
        "sent",
        "delivered",
        "read",
        "failed",
        "unknown",
      ],
      default: "unknown",
      index: true,
    },
    status_history: {
      type: [statusHistorySchema],
      default: [],
    },
    phone_normalized: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    wa_id: {
      type: String,
      trim: true,
      default: "",
    },
    message_type: {
      type: String,
      enum: [
        "text",
        "template",
        "image",
        "document",
        "audio",
        "video",
        "location",
        "interactive",
        "unknown",
      ],
      default: "unknown",
    },
    text: {
      type: String,
      trim: true,
      default: "",
    },
    template_id: {
      type: String,
      trim: true,
      default: "",
    },
    variables: [{ type: String }],
    media_url: {
      type: String,
      trim: true,
      default: "",
    },
    error: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    raw: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    occurred_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true },
);

whatsappMessageSchema.index({ conversation_id: 1, occurred_at: -1 });

const WhatsAppMessage =
  mongoose.models.WhatsAppMessage ||
  mongoose.model("WhatsAppMessage", whatsappMessageSchema);

export default WhatsAppMessage;
