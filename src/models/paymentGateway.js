import mongoose from "mongoose";
const PaymentGatewaySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true },
    displayName: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    priority: { type: Number, default: 100 },
    methods: [{ type: String }],
    config: mongoose.Schema.Types.Mixed,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
  },
  { timestamps: true },
);
export default mongoose.models.AquaPaymentGateway ||
  mongoose.model("AquaPaymentGateway", PaymentGatewaySchema);
