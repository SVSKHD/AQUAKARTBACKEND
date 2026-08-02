import mongoose from "mongoose";

const InvoiceAccessTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    phoneNormalized: { type: String, default: "", index: true },
    emailNormalized: { type: String, required: true, lowercase: true },
    invoiceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AquaInvoice",
        required: true,
      },
    ],
    purpose: {
      type: String,
      enum: ["invoice-list", "invoice-delivery"],
      default: "invoice-list",
    },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    consumedAt: { type: Date, default: null },
    requestIpHash: String,
    userAgentHash: String,
  },
  { timestamps: true },
);

export default mongoose.models.InvoiceAccessToken ||
  mongoose.model("InvoiceAccessToken", InvoiceAccessTokenSchema);
