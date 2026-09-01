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
    reminderType: {
      type: String,
      enum: ["regeneration", "annual-service", "warranty-expiry"],
      required: true,
    },
    dueDate: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
    channel: { type: String, enum: ["whatsapp"] },
    errorCode: String,
  },
  { timestamps: true },
);

export default mongoose.models.ServiceReminderDelivery ||
  mongoose.model("ServiceReminderDelivery", ServiceReminderDeliverySchema);
