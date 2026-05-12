import mongoose from "mongoose";

const NotificationLogSchema = new mongoose.Schema(
  {
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaInvoice" },
    phone: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ["sent", "failed"], required: true },
    response: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

export default mongoose.models.NotificationLog ||
  mongoose.model("NotificationLog", NotificationLogSchema);
