import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const QuotationProductSchema = new mongoose.Schema(
  {
    productId: {
      type: ObjectId,
      ref: "AquaProduct",
    },
    productName: { type: String },
    productDescription: { type: String },
    productSerialNo: { type: String },
    productQuantity: { type: Number, default: 1 },
    productPrice: { type: Number, default: 0 },
    productDiscount: { type: Number, default: 0 },
    productTax: { type: Number, default: 0 },
    productTotal: { type: Number, default: 0 },
  },
  { _id: true },
);

const AquaQuotationSchema = new mongoose.Schema(
  {
    quotationNo: { type: String, unique: true, index: true },
    date: { type: String },
    validUntil: { type: Date },
    customer: {
      type: ObjectId,
      ref: "AquaEcomUser",
    },
    customerDetails: {
      name: { type: String },
      phone: { type: Number },
      email: { type: String },
      address: { type: String },
    },
    gst: { type: Boolean, default: false },
    gstDetails: {
      gstName: { type: String },
      gstNo: { type: String },
      gstPhone: { type: Number },
      gstEmail: { type: String },
      gstAddress: { type: String },
    },
    products: [QuotationProductSchema],
    subTotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: ["Draft", "Sent", "Accepted", "Rejected", "Expired", "Converted"],
      default: "Draft",
    },
    convertedToInvoice: {
      type: ObjectId,
      ref: "AquaInvoice",
    },
    convertedToOrder: {
      type: ObjectId,
      ref: "AquaOrder",
    },
    notes: { type: String },
    terms: { type: String },
    createdBy: {
      type: ObjectId,
      ref: "AquaAdminUser",
    },
  },
  { timestamps: true },
);

const AquaQuotation =
  mongoose.models.AquaQuotation ||
  mongoose.model("AquaQuotation", AquaQuotationSchema);

export default AquaQuotation;
