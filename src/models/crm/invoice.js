import mongoose, { ObjectId } from "mongoose";
import {
  normalizeEmail,
  normalizeIndianPhone,
} from "../../utils/invoiceAccess.js";

const AquaInvoiceSchema = new mongoose.Schema(
  {
    invoiceNo: { type: String },
    date: { type: String },
    customerDetails: {
      name: { type: String },
      phone: { type: Number },
      email: { type: String },
      address: { type: String },
    },
    customerPhoneNormalized: { type: String, index: true },
    customerEmailNormalized: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
    },
    firebaseUid: { type: String, index: true, sparse: true },
    accessMetrics: {
      openCount: { type: Number, default: 0, min: 0 },
      lastOpenedAt: { type: Date },
    },
    emailUpdateAudit: [
      {
        previousEmail: { type: String, default: "" },
        newEmail: { type: String, required: true },
        firebaseUid: { type: String, required: true },
        changedAt: { type: Date, default: Date.now },
        requestIpHash: String,
        userAgentHash: String,
      },
    ],
    gst: { type: Boolean, default: false },
    po: { type: Boolean, default: false },
    quotation: { type: Boolean, default: false },
    gstDetails: {
      gstName: { type: String },
      gstNo: { type: String },
      gstPhone: { type: Number },
      gstEmail: { type: String },
      gstAddress: { type: String },
    },
    products: [
      {
        productName: { type: String },
        productQuantity: { type: Number },
        productPrice: { type: Number },
        productSerialNo: { type: String },
        productId: { type: ObjectId, ref: "AquaProduct" },
        productSlug: { type: String },
        productLink: { type: String },
      },
    ],
    transport: {
      deliveredBy: { type: String },
      deliveryDate: { type: String },
    },
    review: { type: String },
    paidStatus: { type: String },
    aquakartOnlineUser: { type: Boolean, default: false },
    aquakartInvoice: { type: Boolean, default: false },
    sourceOrderId: {
      type: ObjectId,
      ref: "AquaOrder",
      default: null,
      index: true,
    },
    sourceOrderNo: { type: String },
    sourceOrderCollection: {
      type: String,
      enum: ["AquaOrder", "AquaCRMOrder", "manual"],
      default: "manual",
    },
    productId: { type: ObjectId, ref: "AquaProduct" },
    paymentType: { type: String },
  },
  { timestamps: true },
);

AquaInvoiceSchema.pre("save", function normalizeInvoiceOwnership() {
  this.customerPhoneNormalized = normalizeIndianPhone(
    this.customerDetails?.phone,
  );
  this.customerEmailNormalized = normalizeEmail(this.customerDetails?.email);
});

AquaInvoiceSchema.pre("findOneAndUpdate", function normalizeUpdatedOwnership() {
  const update = this.getUpdate() || {};
  const details = update.customerDetails || update.$set?.customerDetails;
  if (!details) return;
  const normalized = {
    customerPhoneNormalized: normalizeIndianPhone(details.phone),
    customerEmailNormalized: normalizeEmail(details.email),
  };
  if (update.$set) Object.assign(update.$set, normalized);
  else Object.assign(update, normalized);
});

const AquaInvoice =
  mongoose.models.AquaInvoice ||
  mongoose.model("AquaInvoice", AquaInvoiceSchema);

export default AquaInvoice;
