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
    // Set when the invoice was created from a sold quotation.
    sourceQuotationId: {
      type: ObjectId,
      ref: "AquaQuotation",
      default: null,
      index: true,
    },
    sourceQuotationNo: { type: String },
    // Set when the invoice was created from a paid pre-invoice. Unique (see
    // the partial index below), so one pre-invoice can never get two invoices.
    sourcePreInvoiceId: { type: ObjectId, ref: "AquaPreInvoice" },
    sourcePreInvoiceNo: { type: String },
    // Set when a transporter created the invoice through Transit. Unique (see
    // the partial index below): one transit can never get two invoices.
    sourceTransitId: { type: ObjectId, ref: "AquaTransit" },
    // Delivery snapshot copied from the transit. Not editable through invoice
    // updates; only the audited transit correction may change it.
    transitDelivery: {
      address: { type: String },
      warehouse: { lat: Number, lng: Number, name: String },
      destination: { lat: Number, lng: Number, source: String },
      distanceKm: { type: Number },
      provider: { type: String },
      snapshotHash: { type: String },
    },
    productId: { type: ObjectId, ref: "AquaProduct" },
    paymentType: { type: String },
    migrated: { type: Boolean, default: false, index: true },
    migrationReviewed: { type: Boolean, default: false, index: true },
    migrationReviewedAt: { type: Date },
  },
  { timestamps: true },
);

// Non-unique: existing data may already repeat numbers. Used by the MCP
// invoice audit's duplicate check (src/services/mcp/invoiceStore.js).
AquaInvoiceSchema.index({ invoiceNo: 1 });

// Only documents that actually carry a pre-invoice id are indexed, so
// existing invoices are unaffected.
AquaInvoiceSchema.index(
  { sourcePreInvoiceId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourcePreInvoiceId: { $type: "objectId" } },
  },
);

AquaInvoiceSchema.index(
  { sourceTransitId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceTransitId: { $type: "objectId" } },
  },
);

// Fields owned by Transit. Ordinary invoice updates (the CRM edit form sends
// the whole invoice back) silently drop them; only a transit correction
// (query option transitCorrection: true) may write them.
export const TRANSIT_OWNED_INVOICE_PATHS = [
  "sourceTransitId",
  "transitDelivery",
];

export const stripTransitOwnedFields = (update = {}) => {
  const owned = (key) =>
    TRANSIT_OWNED_INVOICE_PATHS.some(
      (path) => key === path || key.startsWith(`${path}.`),
    );
  for (const key of Object.keys(update)) {
    if (key.startsWith("$") && update[key] && typeof update[key] === "object") {
      for (const inner of Object.keys(update[key]))
        if (owned(inner)) delete update[key][inner];
    } else if (owned(key)) delete update[key];
  }
  return update;
};

function protectTransitFields() {
  if (this.getOptions().transitCorrection === true) return;
  stripTransitOwnedFields(this.getUpdate() || {});
}
AquaInvoiceSchema.pre("findOneAndUpdate", protectTransitFields);
AquaInvoiceSchema.pre("updateOne", protectTransitFields);
AquaInvoiceSchema.pre("updateMany", protectTransitFields);

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
