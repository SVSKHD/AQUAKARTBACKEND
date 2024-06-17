import mongoose from "mongoose";

const AquaPaymentSchema = new mongoose.Schema({
  invoiceId: {
    type: mongoose.Schema.ObjectId,
    ref: "AquaInvoice",
    required: true,
  },
  paymentLink: {
    type: String,
  },
  paymentStatus: { type: Boolean },
  paymentinfo: {},
  userDetails: {
    phone: {
      type: Number,
    },
    name: {
      type: String,
    },
  },
});

const AquaPayment =
  mongoose.models.AquaPayment ||
  mongoose.model("AquaPayment", AquaPaymentSchema);

export default AquaPayment;
