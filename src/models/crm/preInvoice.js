import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// A pre-invoice: the payable document between a quotation and the final
// invoice (docs/OFFLINE_PAYMENT_LINKS.md). Its stored totals are the only
// source of the amount a payment link charges. It has its own number series
// (AQPI|YYYYMMDD|0001) so it never consumes a final invoice number. Lines
// have the same shape as quotation lines; totals are computed by the
// server with the quotation formula (calculateTotals).

export const PRE_INVOICE_STATUSES = [
  "Draft",
  "Payment Pending",
  "Paid",
  "Cancelled",
  "Converted",
];

const PreInvoiceProductSchema = new mongoose.Schema(
  {
    productId: { type: ObjectId, ref: "AquaProduct" },
    productName: { type: String, required: true, trim: true },
    productDescription: { type: String, default: "" },
    productSerialNo: { type: String, default: "" },
    productQuantity: { type: Number, default: 1, min: 0 },
    productPrice: { type: Number, default: 0, min: 0 },
    productDiscount: { type: Number, default: 0, min: 0 },
    productTax: { type: Number, default: 0, min: 0 },
    productTotal: { type: Number, default: 0 },
  },
  { _id: true },
);

const AquaPreInvoiceSchema = new mongoose.Schema(
  {
    preInvoiceNo: { type: String, required: true, unique: true },
    date: { type: String },
    customerDetails: {
      name: { type: String, trim: true },
      phone: { type: Number },
      email: { type: String, trim: true, default: "" },
      address: { type: String, trim: true, default: "" },
    },
    customerPhoneNormalized: { type: String, index: true },
    gst: { type: Boolean, default: false },
    gstDetails: {
      gstName: { type: String },
      gstNo: { type: String },
      gstPhone: { type: Number },
      gstEmail: { type: String },
      gstAddress: { type: String },
    },
    products: [PreInvoiceProductSchema],
    subTotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: PRE_INVOICE_STATUSES,
      default: "Draft",
      index: true,
    },
    payment: {
      status: {
        type: String,
        enum: ["Unpaid", "Paid"],
        default: "Unpaid",
      },
      amountPaid: { type: Number, default: 0 },
      transactionId: { type: String },
      paidAt: { type: Date },
      mode: { type: String, default: "" },
    },
    sourceQuotationId: {
      type: ObjectId,
      ref: "AquaQuotation",
      default: null,
      index: true,
    },
    sourceQuotationNo: { type: String },
    // Quotation status before the move, restored if this is cancelled.
    sourceQuotationStatus: { type: String },
    convertedToInvoice: { type: ObjectId, ref: "AquaInvoice", default: null },
    createdBy: { type: ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: ObjectId, ref: "AquaAdminUser" },
  },
  { timestamps: true },
);

AquaPreInvoiceSchema.index({ createdAt: -1 });

const AquaPreInvoice =
  mongoose.models.AquaPreInvoice ||
  mongoose.model("AquaPreInvoice", AquaPreInvoiceSchema);

export default AquaPreInvoice;
