import mongoose from "mongoose";

/*
 * Easy invoice drafts (CRM /invoice/easy), shared by all staff and devices.
 * One editor at a time: `editor` is the lock, kept alive by heartbeats.
 * `content` is the CRM page state ({ rawText, doc, view }); it never creates
 * an invoice by itself.
 */

export const EASY_DRAFT_STATUSES = ["open", "done", "discarded"];
export const EASY_DRAFT_EVENTS = [
  "created",
  "claimed",
  "taken_over",
  "released",
  "completed",
  "discarded",
];

const staffSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    name: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const deviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, trim: true },
    label: { type: String, trim: true, default: "" },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    name: { type: String, trim: true, default: "" },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const editorSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    name: { type: String, trim: true, default: "" },
    deviceId: { type: String, trim: true, default: "" },
    deviceLabel: { type: String, trim: true, default: "" },
    since: { type: Date, default: Date.now },
    heartbeatAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, enum: EASY_DRAFT_EVENTS, required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    name: { type: String, trim: true, default: "" },
    deviceId: { type: String, trim: true, default: "" },
    deviceLabel: { type: String, trim: true, default: "" },
    /** For taken_over: who lost the lock. */
    fromName: { type: String, trim: true, default: "" },
    fromDeviceId: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const easyInvoiceDraftSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: EASY_DRAFT_STATUSES,
      default: "open",
      index: true,
    },
    content: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: staffSchema, default: () => ({}) },
    updatedBy: { type: staffSchema, default: () => ({}) },
    devices: { type: [deviceSchema], default: [] },
    editor: { type: editorSchema, default: null },
    events: { type: [eventSchema], default: [] },
    invoiceId: { type: String, trim: true, default: "" },
    /** Bumped on every write; lock changes compare-and-set on it. */
    rev: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);

easyInvoiceDraftSchema.index({ status: 1, updatedAt: -1 });

export default mongoose.models.EasyInvoiceDraft ||
  mongoose.model("EasyInvoiceDraft", easyInvoiceDraftSchema);
