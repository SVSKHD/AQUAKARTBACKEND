import mongoose from "mongoose";

const ServiceReminderDeliverySchema = new mongoose.Schema(
  {
    dedupeKey: { type: String, required: true, unique: true, index: true },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaInvoice",
      required: true,
      index: true,
    },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaProduct" },
    productName: { type: String, required: true },
    customerName: String,
    customerPhone: String,
    invoiceNo: String,
    reminderType: {
      type: String,
      enum: ["regeneration", "annual-service", "warranty-expiry"],
      required: true,
    },
    dueDate: { type: Date, required: true, index: true },
    purchaseDate: Date,
    warrantyExpiresAt: Date,
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "confirmed"],
      default: "pending",
    },
    channel: { type: String, enum: ["whatsapp"] },
    errorCode: String,
    confirmationToken: { type: String, unique: true, sparse: true, index: true },
    confirmationStatus: {
      type: String,
      enum: ["unconfirmed", "confirmed", "service-required", "completed", "not-required", "no-response"],
      default: "unconfirmed",
      index: true,
    },
    confirmedAt: Date,
    confirmedBy: { type: String, enum: ["customer", "staff"] },
    confirmationNotes: { type: String, maxlength: 1000 },
    lastSentAt: Date,
    attemptCount: { type: Number, default: 0 },
    attempts: [{
      attemptedAt: { type: Date, default: Date.now },
      status: { type: String, enum: ["sent", "failed"] },
      channel: { type: String, default: "whatsapp" },
      errorCode: String,
    }],
  },
  { timestamps: true },
);

export default mongoose.models.ServiceReminderDelivery ||
  mongoose.model("ServiceReminderDelivery", ServiceReminderDeliverySchema);
