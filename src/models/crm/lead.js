import mongoose from "mongoose";

const LEAD_STATUSES = ["new", "contacted", "qualified", "lost"];
const LEAD_PAYMENT_STATUSES = ["pending", "cod", "paid"];

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
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: "new",
      index: true,
    },
    source: {
      type: String,
      trim: true,
      default: "",
      index: true,
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
});

const AquaLead =
  mongoose.models.AquaLead || mongoose.model("AquaLead", leadSchema);

export { LEAD_STATUSES, LEAD_PAYMENT_STATUSES };
export default AquaLead;
