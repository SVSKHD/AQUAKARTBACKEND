import mongoose from "mongoose";

const whatsappConversationSchema = new mongoose.Schema(
  {
    phone_normalized: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    wa_id: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    contact_name: {
      type: String,
      trim: true,
      default: "",
    },
    lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaLead",
      default: null,
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
    status: {
      type: String,
      enum: ["open", "closed", "archived"],
      default: "open",
      index: true,
    },
    unread_count: {
      type: Number,
      min: 0,
      default: 0,
      index: true,
    },
    last_message_at: {
      type: Date,
      default: null,
      index: true,
    },
    last_message_direction: {
      type: String,
      enum: ["inbound", "outbound", ""],
      default: "",
    },
    last_message_preview: {
      type: String,
      trim: true,
      default: "",
    },
    last_inbound_at: { type: Date, default: null },
    last_outbound_at: { type: Date, default: null },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
      index: true,
    },
    tags: [{ type: String, trim: true }],
  },
  { timestamps: true },
);

whatsappConversationSchema.index({ last_message_at: -1, status: 1 });

const WhatsAppConversation =
  mongoose.models.WhatsAppConversation ||
  mongoose.model("WhatsAppConversation", whatsappConversationSchema);

export default WhatsAppConversation;
