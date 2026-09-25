import mongoose from "mongoose";

const DEAL_STAGES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
];

const dealSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Deal title is required"],
      trim: true,
      index: true,
    },
    amount: {
      type: Number,
      required: [true, "Deal amount is required"],
      min: [0, "Deal amount cannot be negative"],
      default: 0,
    },
    stage: {
      type: String,
      enum: DEAL_STAGES,
      default: "prospecting",
      index: true,
    },
    probability: {
      type: Number,
      min: [0, "Probability must be at least 0"],
      max: [100, "Probability cannot exceed 100"],
      default: 0,
    },
    expected_close_date: {
      type: Date,
      default: null,
      index: true,
    },
    notes: {
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
    quotation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaQuotation",
      default: null,
    },
    order_id: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    order_type: {
      type: String,
      enum: ["crm", "ecommerce", ""],
      default: "",
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
      index: true,
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

dealSchema.index({ stage: 1, expected_close_date: 1 });
dealSchema.index({ title: "text", notes: "text" });

const AquaDeal =
  mongoose.models.AquaDeal || mongoose.model("AquaDeal", dealSchema);

export { DEAL_STAGES };
export default AquaDeal;
