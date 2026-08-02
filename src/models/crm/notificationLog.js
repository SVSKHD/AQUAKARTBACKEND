import mongoose from "mongoose";

const NotificationLogSchema = new mongoose.Schema(
  {
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaInvoice" },
    phone: { type: String },
    channel: { type: String, enum: ["whatsapp", "email"], default: "whatsapp" },
    recipientMasked: String,
    template: String,
    providerMessageId: String,
    firebaseUid: String,
    requestIpHash: String,
    dedupeKey: { type: String, unique: true, sparse: true, index: true },
    errorCode: String,
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      required: true,
    },
    response: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

export default mongoose.models.NotificationLog ||
  mongoose.model("NotificationLog", NotificationLogSchema);
