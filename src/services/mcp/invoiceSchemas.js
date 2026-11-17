import * as z from "zod";
import { MCP_SCOPES } from "./config.js";
import { IDEMPOTENCY_KEY, OBJECT_ID } from "../../validators/mcp/blog.js";
import {
  INVOICE_ACTION_STATUSES,
  INVOICE_ACTION_TYPES,
} from "../../models/mcp/invoiceAction.js";

// MCP tool definitions for the invoice data-quality audit. The `register`
// helper from server.js adds scope checks, envelopes and audit log lines.
// invoices:audit reads; invoices:actions applies or dismisses suggestions.

const objectId = z.string().regex(OBJECT_ID, "must be a 24-character id");
const actionId = z
  .string()
  .regex(/^ina_[0-9a-f-]{36}$/, "an actionId from aquakart_audit_invoices");
const idempotencyKey = z
  .string()
  .regex(IDEMPOTENCY_KEY, "8-128 letters, digits, '.', '_', ':' or '-'")
  .describe(
    "Unique per intended action. Reuse the SAME key when retrying after a timeout; never reuse it for a different action.",
  );
const day = z.string().max(40).describe("YYYY-MM-DD or ISO 8601 date-time");
const envelope = (shape, write = false) =>
  z.object({
    ok: z.literal(true),
    correlationId: z.string(),
    ...(write ? { operationId: z.string(), replayed: z.boolean() } : {}),
    ...shape,
  });

const candidate = z.object({
  candidateId: z.string(),
  source: z.string(),
  value: z.string(),
  confidence: z.number(),
  reference: z.string().nullable(),
});
const actionSummary = z.object({
  actionId: z.string(),
  type: z.enum(INVOICE_ACTION_TYPES),
  status: z.enum(INVOICE_ACTION_STATUSES),
  invoiceId: z.string().nullable(),
  invoiceNo: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  documentKind: z.string(),
  migrated: z.boolean(),
  relatedInvoiceIds: z.array(z.string()),
  primaryInvoiceId: z.string().nullable(),
  suspectedDuplicateId: z.string().nullable(),
  field: z.string().nullable(),
  confidence: z.number(),
  executable: z.boolean(),
  requiresApproval: z.boolean(),
  hasSuggestion: z.boolean(),
  suggestedAction: z.string().nullable(),
  expectedRevision: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
const actionFull = actionSummary.extend({
  currentValue: z.string().nullable(),
  suggestedValue: z.string().nullable(),
  suggestedCandidateId: z.string().nullable(),
  candidates: z.array(candidate),
  evidence: z.record(z.string(), z.unknown()),
  confidenceBasis: z.array(z.string()),
  execution: z
    .object({
      operationId: z.string().nullable(),
      executedBy: z.string().nullable(),
      executedAt: z.string().nullable(),
      approvalNote: z.string().nullable(),
      candidateId: z.string().nullable(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    })
    .nullable(),
  ignored: z
    .object({
      by: z.string().nullable(),
      at: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  history: z.array(
    z.object({
      status: z.string(),
      at: z.string().nullable(),
      by: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});
const invoiceState = z.object({
  invoiceId: z.string(),
  invoiceNo: z.string().nullable(),
  date: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  documentKind: z.string(),
  migrated: z.boolean(),
  revision: z.string(),
  customerName: z.string().nullable(),
  customerPhoneMasked: z.string().nullable(),
  address: z.string().nullable(),
  addressStatus: z.string(),
  total: z.number(),
  productCount: z.number(),
  paidStatus: z.string().nullable(),
  sourceOrderNo: z.string().nullable(),
  sourceQuotationNo: z.string().nullable(),
});
const pageFields = {
  page: z.number().int().min(1).max(1000).default(1),
  limit: z.number().int().min(1).max(50).default(20),
};
const pageOut = {
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
};

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};

export const registerInvoiceTools = (
  register,
  { invoiceAuditTools, invoiceActionTools },
) => {
  register(
    "aquakart_audit_invoices",
    {
      title: "Scan invoices for data-quality issues",
      description:
        "Scans invoices (by record creation time, oldest first) for missing or placeholder customer addresses and possible duplicate invoices, and saves each finding as a suggested action for review. NEVER changes invoices. Duplicate timing uses each invoice's own date. Quotation and PO documents are only compared with their own kind; migrated (bulk-imported) invoices are skipped unless includeMigrated. Use nextCursor to continue. dryRun returns findings without saving them.",
      scopes: [MCP_SCOPES.invoicesAudit],
      input: z.strictObject({
        from: day.optional().describe("Default: 90 days before `to`"),
        to: day.optional().describe("Default: now"),
        cursor: objectId
          .optional()
          .describe("nextCursor from the previous scan page"),
        limit: z.number().int().min(1).max(2000).default(200),
        issueTypes: z
          .array(z.enum(["missing_address", "duplicates"]))
          .min(1)
          .max(2)
          .optional(),
        documentKinds: z
          .array(z.enum(["invoice", "po", "quotation"]))
          .min(1)
          .max(3)
          .optional()
          .describe("Default ['invoice']"),
        includeMigrated: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      }),
      output: envelope({
        summary: z.object({
          scanned: z.number(),
          missingAddress: z.number(),
          incompleteAddress: z.number(),
          noAddressEvidence: z.number(),
          duplicatePairs: z.number(),
          created: z.number(),
          refreshed: z.number(),
          reopened: z.number(),
          unchanged: z.number(),
          staleMarked: z.number(),
          migratedScanned: z.number(),
        }),
        issues: z.array(
          z.object({
            actionId: z.string().nullable(),
            type: z.string(),
            invoiceId: z.string(),
            relatedInvoiceIds: z.array(z.string()),
            confidence: z.number(),
            status: z.string(),
            outcome: z.string(),
          }),
        ),
        range: z.object({ from: z.string(), to: z.string() }),
        nextCursor: z.string().nullable(),
        hasMore: z.boolean(),
        dryRun: z.boolean(),
        invoicesChanged: z.literal(0),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    (args) => invoiceAuditTools.auditInvoices(args),
  );

  register(
    "aquakart_list_invoice_actions",
    {
      title: "List suggested invoice actions",
      description:
        "Suggested actions from invoice scans, newest first. Filter by type, status, confidence, invoice date range, customer phone or invoice id.",
      scopes: [MCP_SCOPES.invoicesAudit],
      input: z.strictObject({
        type: z.enum(INVOICE_ACTION_TYPES).optional(),
        status: z.enum(INVOICE_ACTION_STATUSES).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        maxConfidence: z.number().min(0).max(1).optional(),
        from: day.optional().describe("Invoice date from"),
        to: day.optional().describe("Invoice date to"),
        customerPhone: z
          .string()
          .max(20)
          .optional()
          .describe("Customer mobile number (matched after normalizing)"),
        invoiceId: objectId.optional(),
        ...pageFields,
      }),
      output: envelope({ actions: z.array(actionSummary), ...pageOut }),
      annotations: READ,
    },
    (args) => invoiceAuditTools.listInvoiceActions(args),
  );

  register(
    "aquakart_get_invoice_action",
    {
      title: "Get a suggested invoice action",
      description:
        "One suggested action with its evidence, address candidates, confidence basis, history and the affected invoices' current state (wouldBeStale tells whether executing it now would be refused).",
      scopes: [MCP_SCOPES.invoicesAudit],
      input: z.strictObject({ actionId }),
      output: envelope({
        action: actionFull,
        currentState: z.object({
          invoices: z.array(invoiceState),
          missingInvoiceIds: z.array(z.string()),
          invoiceChangedSinceScan: z.boolean(),
          wouldBeStale: z.boolean(),
        }),
        recommendation: z.string().nullable(),
      }),
      annotations: READ,
    },
    (args) => invoiceAuditTools.getInvoiceAction(args),
  );

  register(
    "aquakart_get_invoice_audit_history",
    {
      title: "Invoice audit history",
      description:
        "Executed, ignored, failed and stale suggestions, most recently changed first, with previous and applied values.",
      scopes: [MCP_SCOPES.invoicesAudit],
      input: z.strictObject({
        invoiceId: objectId.optional(),
        actionId: actionId.optional(),
        status: z.enum(["executed", "ignored", "failed", "stale"]).optional(),
        ...pageFields,
      }),
      output: envelope({ entries: z.array(actionFull), ...pageOut }),
      annotations: READ,
    },
    (args) => invoiceAuditTools.getInvoiceAuditHistory(args),
  );

  register(
    "aquakart_execute_invoice_action",
    {
      title: "Apply an approved invoice suggestion",
      description:
        "Applies ONE FILL_MISSING_ADDRESS suggestion after an admin explicitly approved it: fills the invoice's missing customer address with the reviewed candidate. Needs the action's expectedRevision and approval.confirmed=true. The server re-checks that the invoice is unchanged, the address is still missing and the evidence still holds; otherwise the action becomes stale (ACTION_STALE). Duplicate suggestions are never executable (MANUAL_REVIEW_REQUIRED). Never deletes, voids, renumbers or changes totals.",
      scopes: [MCP_SCOPES.invoicesActions],
      input: z.strictObject({
        idempotencyKey,
        actionId,
        expectedRevision: z
          .string()
          .min(1)
          .max(40)
          .describe("expectedRevision of the action you reviewed"),
        candidateId: z
          .string()
          .regex(/^cand_[0-9a-f]{16}$/)
          .optional()
          .describe(
            "Address candidate the reviewer chose; default is the suggested one",
          ),
        approval: z
          .strictObject({
            confirmed: z.literal(true),
            note: z
              .string()
              .min(3)
              .max(500)
              .describe(
                "Who approved and why, e.g. 'Approved by Ravi in CRM review'",
              ),
          })
          .describe("Explicit admin approval for this change"),
      }),
      output: envelope(
        {
          action: actionFull,
          invoice: z
            .object({
              invoiceId: z.string(),
              invoiceNo: z.string().nullable(),
              revision: z.string(),
            })
            .optional(),
          alreadyExecuted: z.boolean(),
        },
        true,
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    (args, ctx) => invoiceActionTools.executeInvoiceAction(args, ctx),
  );

  register(
    "aquakart_ignore_invoice_action",
    {
      title: "Dismiss an invoice suggestion",
      description:
        "Marks a suggestion as ignored (for example a false duplicate or a wrong address). Never changes the invoice. Later scans keep it ignored.",
      scopes: [MCP_SCOPES.invoicesActions],
      input: z.strictObject({
        idempotencyKey,
        actionId,
        reason: z.string().min(3).max(500),
      }),
      output: envelope(
        { action: actionFull, alreadyIgnored: z.boolean() },
        true,
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    (args, ctx) => invoiceActionTools.ignoreInvoiceAction(args, ctx),
  );
};
