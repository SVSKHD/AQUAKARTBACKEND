import mongoose from "mongoose";

// One suggested fix from the MCP invoice data-quality audit
// (src/services/mcp/invoiceAuditTools.js). Scans create or refresh these;
// they never change invoices. Only aquakart_execute_invoice_action, with
// explicit approval, may apply a FILL_MISSING_ADDRESS suggestion.
//
// issueKey is a stable SHA-256 identity of the problem (type + invoice ids +
// field), so re-scanning refreshes the same record instead of adding
// duplicates. expectedRevision is the invoice's updatedAt (ISO) at scan time;
// if the invoice changes before execution the action becomes `stale`.
//
// Customer phone numbers are not copied here: customerKey is a SHA-256 of
// the normalized number, used only for filtering.

export const INVOICE_ACTION_TYPES = [
  "FILL_MISSING_ADDRESS",
  "REVIEW_INCOMPLETE_ADDRESS",
  "REQUEST_ADDRESS",
  "REVIEW_DUPLICATE_INVOICE",
];
export const INVOICE_ACTION_STATUSES = [
  "pending_review",
  "approved",
  "executing",
  "executed",
  "ignored",
  "failed",
  "stale",
];

const CandidateSchema = new mongoose.Schema(
  {
    candidateId: String,
    source: String,
    value: String,
    confidence: Number,
    reference: String,
  },
  { _id: false },
);

const InvoiceActionSchema = new mongoose.Schema(
  {
    actionId: { type: String, required: true, unique: true },
    issueKey: { type: String, required: true, unique: true },
    type: { type: String, enum: INVOICE_ACTION_TYPES, required: true },
    status: {
      type: String,
      enum: INVOICE_ACTION_STATUSES,
      default: "pending_review",
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaInvoice",
      required: true,
    },
    relatedInvoiceIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "AquaInvoice" },
    ],
    invoiceNo: String,
    invoiceDate: Date,
    documentKind: { type: String, enum: ["invoice", "po", "quotation"] },
    migrated: { type: Boolean, default: false },
    customerKey: String,
    field: String,
    currentValue: { type: String, default: null },
    suggestedValue: { type: String, default: null },
    suggestedCandidateId: { type: String, default: null },
    candidates: { type: [CandidateSchema], default: [] },
    suggestedAction: String,
    evidence: mongoose.Schema.Types.Mixed,
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    confidenceBasis: [String],
    requiresApproval: { type: Boolean, default: true },
    executable: { type: Boolean, default: false },
    expectedRevision: String,
    relatedRevisions: mongoose.Schema.Types.Mixed,
    firstSeenAt: Date,
    lastSeenAt: Date,
    executingUntil: Date,
    execution: {
      operationId: String,
      executedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AquaAdminUser",
      },
      clientId: String,
      executedAt: Date,
      approvalNote: String,
      candidateId: String,
      before: { type: String, default: null },
      after: { type: String, default: null },
    },
    ignored: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
      at: Date,
      reason: String,
    },
    lastError: { code: String, message: String, at: Date },
    history: {
      type: [
        {
          _id: false,
          status: String,
          at: Date,
          by: String,
          note: String,
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

InvoiceActionSchema.index({ status: 1, type: 1, createdAt: -1 });
InvoiceActionSchema.index({ invoiceId: 1, createdAt: -1 });
InvoiceActionSchema.index({ relatedInvoiceIds: 1 });
InvoiceActionSchema.index({ customerKey: 1 });
InvoiceActionSchema.index({ invoiceDate: -1 });

const InvoiceAction =
  mongoose.models.AquaMcpInvoiceAction ||
  mongoose.model("AquaMcpInvoiceAction", InvoiceActionSchema);

export default InvoiceAction;
