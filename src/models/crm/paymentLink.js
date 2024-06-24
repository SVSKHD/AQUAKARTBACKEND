import mongoose from "mongoose";

const AquaPaymentSchema = new mongoose.Schema({
  referenceId: {
    type: String,
    ref: "AquaInvoice",
  },
  invoiceId: {
    type: String,
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