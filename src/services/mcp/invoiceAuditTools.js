import { randomUUID } from "node:crypto";
import { BlogToolError } from "./errors.js";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";
import {
  classifyAddress,
  compareInvoices,
  customerKeyOf,
  documentKind,
  formatCrmOrderAddress,
  formatOrderAddress,
  formatUserAddress,
  invoiceDateOf,
  invoiceTotal,
  issueKeyOf,
  maskPhone,
  orderPair,
  rankAddressCandidates,
  revisionOf,
} from "./invoiceAuditRules.js";

// Read side of the MCP invoice data-quality audit:
//   aquakart_audit_invoices          scan -> suggested actions
//   aquakart_list_invoice_actions    list suggestions
//   aquakart_get_invoice_action      one suggestion + current invoice state
//   aquakart_get_invoice_audit_history  executed/ignored/stale/failed log
// Scanning NEVER changes invoices: it only creates or refreshes
// AquaMcpInvoiceAction records (or nothing at all with dryRun). Applying a
// suggestion is in invoiceActionTools.js. Phone numbers are masked in every
// result and never logged; addresses are returned only to the authorized
// reviewer and never logged.

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (value) => (value ? new Date(value).toISOString() : null);
const id = (value) => (value ? String(value) : null);

export const ADDRESS_FIELD = "customerDetails.address";
const OPEN_STATUSES = ["pending_review", "approved"];
const REOPEN_STATUSES = ["stale", "failed"];
const ADDRESS_TYPES = [
  "FILL_MISSING_ADDRESS",
  "REVIEW_INCOMPLETE_ADDRESS",
  "REQUEST_ADDRESS",
];
export const HISTORY_STATUSES = ["executed", "ignored", "failed", "stale"];

export const DUPLICATE_RECOMMENDATION =
  "Manual accounting review: confirm in the CRM whether both documents were issued for the same sale, then reconcile through the normal accounting process (cancellation or credit note). MCP never deletes, voids, merges or renumbers invoices.";

// Loads every address that the invoice's own records, its linked customer
// account, or other records with the same phone number hold for it.
export const collectAddressCandidates = async (store, invoice) => {
  const raw = [];
  const evidence = {
    linkedOrder: false,
    linkedCrmOrder: false,
    linkedQuotation: false,
    linkedAccount: false,
    matchedPhone: false,
  };
  const addOrder = (order, label) => {
    if (!order) return;
    evidence.linkedOrder = true;
    const reference = `${label}:${order.orderId || order._id}`;
    raw.push({
      source: "linked_order_shipping",
      value: formatOrderAddress(order.shippingAddress),
      reference,
    });
    raw.push({
      source: "linked_order_billing",
      value: formatOrderAddress(order.billingAddress),
      reference,
    });
  };
  if (invoice.sourceOrderId)
    addOrder(await store.findOrder(invoice.sourceOrderId), "AquaOrder");
  const linked = await store.findOrdersForInvoice(invoice._id);
  for (const order of linked.orders || [])
    if (String(order._id) !== String(invoice.sourceOrderId))
      addOrder(order, "AquaOrder");
  for (const order of linked.crmOrders || []) {
    evidence.linkedCrmOrder = true;
    raw.push({
      source: "linked_crm_order",
      value: formatCrmOrderAddress(order.customer),
      reference: `AquaCRMOrder:${order.orderNumber || order._id}`,
    });
  }
  if (invoice.sourceQuotationId) {
    const quotation = await store.findQuotation(invoice.sourceQuotationId);
    if (quotation) {
      evidence.linkedQuotation = true;
      raw.push({
        source: "linked_quotation",
        value: quotation.customerDetails?.address,
        reference: `AquaQuotation:${quotation.quotationNo || quotation._id}`,
      });
    }
  }
  const accountAddresses = (user, source) => {
    const list = [
      ...(Array.isArray(user?.addresses) ? user.addresses : []),
      ...(user?.selectedAddress ? [user.selectedAddress] : []),
    ];
    for (const address of list)
      raw.push({
        source,
        value: formatUserAddress(address),
        reference: `AquaEcomUser:${user._id}`,
      });
  };
  let accountId = null;
  if (invoice.firebaseUid) {
    const user = await store.findUserByFirebaseUid(invoice.firebaseUid);
    if (user) {
      evidence.linkedAccount = true;
      accountId = String(user._id);
      accountAddresses(user, "linked_account_address");
    }
  }
  const phone = normalizeIndianPhone(
    invoice.customerPhoneNormalized || invoice.customerDetails?.phone,
  );
  if (phone) {
    const user = await store.findUserByPhone(phone);
    if (user && String(user._id) !== accountId) {
      evidence.matchedPhone = true;
      accountAddresses(user, "phone_account_address");
    }
    const others = await store.findInvoiceAddressesByPhone(phone, invoice._id);
    for (const other of others || []) {
      evidence.matchedPhone = true;
      raw.push({
        source: "phone_invoice_history",
        value: other.customerDetails?.address,
        reference: `AquaInvoice:${other.invoiceNo || other._id}`,
      });
    }
  }
  return { raw, evidence, ranked: rankAddressCandidates(raw) };
};

export const invoiceState = (invoice) =>
  invoice && {
    invoiceId: String(invoice._id),
    invoiceNo: invoice.invoiceNo || null,
    date: invoice.date || null,
    invoiceDate: iso(invoiceDateOf(invoice)),
    documentKind: documentKind(invoice),
    migrated: Boolean(invoice.migrated),
    revision: revisionOf(invoice),
    customerName: invoice.customerDetails?.name || null,
    customerPhoneMasked: maskPhone(
      invoice.customerPhoneNormalized || invoice.customerDetails?.phone,
    ),
    address: invoice.customerDetails?.address ?? null,
    addressStatus: classifyAddress(invoice.customerDetails?.address),
    total: invoiceTotal(invoice),
    productCount: Array.isArray(invoice.products) ? invoice.products.length : 0,
    paidStatus: invoice.paidStatus || null,
    sourceOrderNo: invoice.sourceOrderNo || null,
    sourceQuotationNo: invoice.sourceQuotationNo || null,
  };

export const actionSummary = (action) => ({
  actionId: action.actionId,
  type: action.type,
  status: action.status,
  invoiceId: id(action.invoiceId),
  invoiceNo: action.invoiceNo || null,
  invoiceDate: iso(action.invoiceDate),
  documentKind: action.documentKind || "invoice",
  migrated: Boolean(action.migrated),
  relatedInvoiceIds: (action.relatedInvoiceIds || []).map(String),
  primaryInvoiceId:
    action.type === "REVIEW_DUPLICATE_INVOICE" ? id(action.invoiceId) : null,
  suspectedDuplicateId:
    action.type === "REVIEW_DUPLICATE_INVOICE"
      ? id(action.relatedInvoiceIds?.[0])
      : null,
  field: action.field || null,
  confidence: action.confidence ?? 0,
  executable: Boolean(action.executable),
  requiresApproval: action.requiresApproval !== false,
  hasSuggestion: Boolean(action.suggestedValue),
  suggestedAction: action.suggestedAction || null,
  expectedRevision: action.expectedRevision || null,
  createdAt: iso(action.createdAt),
  lastSeenAt: iso(action.lastSeenAt),
  updatedAt: iso(action.updatedAt),
});

export const actionFull = (action) => ({
  ...actionSummary(action),
  currentValue: action.currentValue ?? null,
  suggestedValue: action.suggestedValue ?? null,
  suggestedCandidateId: action.suggestedCandidateId || null,
  candidates: (action.candidates || []).map((item) => ({
    candidateId: item.candidateId,
    source: item.source,
    value: item.value,
    confidence: item.confidence,
    reference: item.reference || null,
  })),
  evidence: action.evidence || {},
  confidenceBasis: action.confidenceBasis || [],
  execution: action.execution?.executedAt
    ? {
        operationId: action.execution.operationId || null,
        executedBy: id(action.execution.executedBy),
        executedAt: iso(action.execution.executedAt),
        approvalNote: action.execution.approvalNote || null,
        candidateId: action.execution.candidateId || null,
        before: action.execution.before ?? null,
        after: action.execution.after ?? null,
      }
    : null,
  ignored: action.ignored?.at
    ? {
        by: id(action.ignored.by),
        at: iso(action.ignored.at),
        reason: action.ignored.reason || null,
      }
    : null,
  lastError: action.lastError?.code
    ? { code: action.lastError.code, message: action.lastError.message || "" }
    : null,
  history: (action.history || []).map((entry) => ({
    status: entry.status,
    at: iso(entry.at),
    by: entry.by || null,
    note: entry.note || null,
  })),
});

const parseDay = (value, field) => {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new BlogToolError("VALIDATION_FAILED", `Invalid ${field}`, [
      { field, message: "Use YYYY-MM-DD or an ISO 8601 date-time" },
    ]);
  return date;
};

export const createInvoiceAuditTools = ({
  store,
  config,
  now = () => new Date(),
}) => {
  const settings = config.invoiceAudit;

  // Builds the address issue (if any) for one invoice.
  const addressIssue = async (invoice) => {
    const current = invoice.customerDetails?.address ?? null;
    const status = classifyAddress(current);
    if (status === "ok") return { status };
    const { ranked, evidence } = await collectAddressCandidates(store, invoice);
    let type = "FILL_MISSING_ADDRESS";
    if (status === "incomplete") type = "REVIEW_INCOMPLETE_ADDRESS";
    else if (!ranked.candidates.length) type = "REQUEST_ADDRESS";
    const suggested = type === "FILL_MISSING_ADDRESS" ? ranked.suggested : null;
    return {
      status,
      action: {
        type,
        invoiceIds: [invoice._id],
        field: ADDRESS_FIELD,
        doc: {
          invoiceId: invoice._id,
          relatedInvoiceIds: [],
          field: ADDRESS_FIELD,
          currentValue: current === null ? null : String(current),
          suggestedValue: suggested?.value ?? null,
          suggestedCandidateId: suggested?.candidateId ?? null,
          candidates: ranked.candidates,
          suggestedAction:
            type === "FILL_MISSING_ADDRESS"
              ? suggested
                ? "FILL_ADDRESS_AFTER_APPROVAL"
                : "CHOOSE_ADDRESS_CANDIDATE"
              : type === "REQUEST_ADDRESS"
                ? "REQUEST_ADDRESS_FROM_CUSTOMER"
                : "REVIEW_ADDRESS_MANUALLY",
          evidence: {
            addressStatus: status,
            source: suggested?.source ?? null,
            reason: ranked.reason,
            conflict: Boolean(ranked.conflict),
            requiresManualConfirmation: Boolean(
              ranked.requiresManualConfirmation,
            ),
            ...evidence,
            // Suggested value comes from this invoice's own order/quotation.
            fromLinkedTransaction: Boolean(suggested && suggested.tier <= 2),
          },
          confidence: suggested ? ranked.confidence : 0,
          confidenceBasis: suggested ? suggested.sources : [],
          requiresApproval: true,
          executable: type === "FILL_MISSING_ADDRESS",
          expectedRevision: revisionOf(invoice),
        },
      },
    };
  };

  // Duplicate candidates of one invoice, as action payloads.
  const duplicateIssues = async (invoice) => {
    let orderIds = [];
    if (invoice.sourceOrderId) {
      const order = await store.findOrder(invoice.sourceOrderId);
      const transactionId = String(order?.transactionId || "").trim();
      if (transactionId)
        orderIds = (
          await store.findOrderIdsByTransaction(
            transactionId,
            invoice.sourceOrderId,
          )
        ).map(String);
    }
    const candidates = await store.findDuplicateCandidates(invoice, {
      transactionOrderIds: orderIds,
    });
    const issues = [];
    for (const other of candidates) {
      const match = compareInvoices(invoice, other, {
        windowDays: settings.duplicateWindowDays,
        transactionMatch:
          Boolean(other.sourceOrderId) &&
          orderIds.includes(String(other.sourceOrderId)),
      });
      if (!match) continue;
      const [primary, duplicate] = orderPair(invoice, other);
      issues.push({
        type: "REVIEW_DUPLICATE_INVOICE",
        invoiceIds: [primary._id, duplicate._id],
        field: "",
        primary,
        doc: {
          invoiceId: primary._id,
          relatedInvoiceIds: [duplicate._id],
          field: null,
          currentValue: null,
          suggestedValue: null,
          suggestedCandidateId: null,
          candidates: [],
          suggestedAction: "REVIEW_FOR_RECONCILIATION",
          evidence: {
            ...match.signals,
            basis: match.basis,
            daysApart: match.daysApart,
            datesKnown: match.datesKnown,
            windowDays: match.windowDays,
            primaryInvoiceNo: primary.invoiceNo || null,
            duplicateInvoiceNo: duplicate.invoiceNo || null,
            primaryTotal: invoiceTotal(primary),
            duplicateTotal: invoiceTotal(duplicate),
            migrated: Boolean(primary.migrated),
            recommendation: DUPLICATE_RECOMMENDATION,
          },
          confidence: match.confidence,
          confidenceBasis: match.basis,
          requiresApproval: true,
          executable: false,
          expectedRevision: revisionOf(primary),
          relatedRevisions: { [String(duplicate._id)]: revisionOf(duplicate) },
        },
      });
    }
    return issues;
  };

  // Create, refresh, reopen or leave a suggestion keyed by issueKey.
  const upsert = async (issue, invoice, retried = false) => {
    const issueKey = issueKeyOf(issue.type, issue.invoiceIds, issue.field);
    const base = issue.primary || invoice;
    const fields = {
      ...issue.doc,
      type: issue.type,
      invoiceNo: base.invoiceNo || null,
      invoiceDate: invoiceDateOf(base),
      documentKind: documentKind(base),
      migrated: Boolean(base.migrated),
      customerKey: customerKeyOf(
        base.customerPhoneNormalized || base.customerDetails?.phone,
      ),
      lastSeenAt: now(),
    };
    const existing = await store.findActionByIssueKey(issueKey);
    if (!existing) {
      try {
        const created = await store.createAction({
          ...fields,
          actionId: `ina_${randomUUID()}`,
          issueKey,
          status: "pending_review",
          firstSeenAt: now(),
          history: [{ status: "pending_review", at: now(), note: "scan" }],
        });
        return { outcome: "created", action: created };
      } catch (error) {
        if (error?.code !== 11000 || retried) throw error;
        return upsert(issue, invoice, true);
      }
    }
    if (OPEN_STATUSES.includes(existing.status)) {
      const action = await store.updateAction(existing.actionId, {
        $set: fields,
      });
      return { outcome: "refreshed", action };
    }
    if (REOPEN_STATUSES.includes(existing.status)) {
      const action = await store.updateAction(existing.actionId, {
        $set: { ...fields, status: "pending_review", lastError: null },
        $push: {
          history: { status: "pending_review", at: now(), note: "re-scan" },
        },
      });
      return { outcome: "reopened", action };
    }
    // executed, ignored or executing: keep the decision.
    const action = await store.updateAction(existing.actionId, {
      $set: { lastSeenAt: now() },
    });
    return { outcome: "unchanged", action: action || existing };
  };

  return {
    async auditInvoices(args = {}) {
      const to = parseDay(args.to, "to") || now();
      const from =
        parseDay(args.from, "from") || new Date(to.getTime() - 90 * DAY_MS);
      if (from > to)
        throw new BlogToolError("VALIDATION_FAILED", "from is after to", [
          { field: "from", message: "must be on or before to" },
        ]);
      if ((to - from) / DAY_MS > settings.scanMaxRangeDays)
        throw new BlogToolError(
          "RANGE_TOO_LARGE",
          `Scan at most ${settings.scanMaxRangeDays} days at a time; use cursor for more`,
          { maxRangeDays: settings.scanMaxRangeDays },
        );
      const limit = Math.min(args.limit || 200, settings.scanMaxInvoices);
      const checks = new Set(
        args.issueTypes || ["missing_address", "duplicates"],
      );
      const kinds = args.documentKinds || ["invoice"];
      const includeMigrated = Boolean(args.includeMigrated);
      const dryRun = Boolean(args.dryRun);

      const page = await store.scanInvoices({
        from,
        to,
        afterId: args.cursor,
        limit: limit + 1,
        kinds,
        includeMigrated,
      });
      const invoices = page.slice(0, limit);
      const hasMore = page.length > limit;
      const summary = {
        scanned: invoices.length,
        missingAddress: 0,
        incompleteAddress: 0,
        noAddressEvidence: 0,
        duplicatePairs: 0,
        created: 0,
        refreshed: 0,
        reopened: 0,
        unchanged: 0,
        staleMarked: 0,
        migratedScanned: invoices.filter((inv) => inv.migrated).length,
      };
      const issues = [];
      const seen = new Set();
      const record = async (issue, invoice) => {
        const key = issueKeyOf(issue.type, issue.invoiceIds, issue.field);
        if (seen.has(key)) return;
        seen.add(key);
        if (dryRun) {
          issues.push({
            actionId: null,
            type: issue.type,
            invoiceId: String(issue.doc.invoiceId),
            relatedInvoiceIds: issue.doc.relatedInvoiceIds.map(String),
            confidence: issue.doc.confidence,
            status: "not_saved",
            outcome: "dry_run",
          });
          return;
        }
        const { outcome, action } = await upsert(issue, invoice);
        summary[outcome] += 1;
        issues.push({
          actionId: action.actionId,
          type: action.type,
          invoiceId: String(action.invoiceId),
          relatedInvoiceIds: (action.relatedInvoiceIds || []).map(String),
          confidence: action.confidence ?? 0,
          status: action.status,
          outcome,
        });
      };

      for (const invoice of invoices) {
        if (checks.has("missing_address")) {
          const result = await addressIssue(invoice);
          if (result.action) {
            if (result.status === "incomplete") summary.incompleteAddress += 1;
            else summary.missingAddress += 1;
            if (result.action.type === "REQUEST_ADDRESS")
              summary.noAddressEvidence += 1;
            await record(result.action, invoice);
          } else if (!dryRun) {
            summary.staleMarked += await store.markOpenActionsStale(
              invoice._id,
              ADDRESS_TYPES,
              { at: now(), note: "address now present" },
            );
          }
        }
        if (checks.has("duplicates")) {
          for (const issue of await duplicateIssues(invoice)) {
            const key = issueKeyOf(issue.type, issue.invoiceIds, issue.field);
            if (!seen.has(key)) summary.duplicatePairs += 1;
            await record(issue, invoice);
          }
        }
      }
      return {
        summary,
        issues: issues.slice(0, 1000),
        range: { from: from.toISOString(), to: to.toISOString() },
        nextCursor: hasMore ? String(invoices.at(-1)._id) : null,
        hasMore,
        dryRun,
        invoicesChanged: 0,
      };
    },

    async listInvoiceActions(args = {}) {
      const page = args.page || 1;
      const limit = Math.min(args.limit || 20, 50);
      const customerKey = args.customerPhone
        ? customerKeyOf(args.customerPhone)
        : undefined;
      if (args.customerPhone && !customerKey)
        throw new BlogToolError(
          "VALIDATION_FAILED",
          "customerPhone is not a valid Indian mobile number",
          [
            {
              field: "customerPhone",
              message: "10-digit mobile, optional +91",
            },
          ],
        );
      const { items, total } = await store.listActions(
        {
          type: args.type,
          status: args.status,
          minConfidence: args.minConfidence,
          maxConfidence: args.maxConfidence,
          invoiceDateFrom: parseDay(args.from, "from"),
          invoiceDateTo: parseDay(args.to, "to"),
          customerKey,
          invoiceId: args.invoiceId,
        },
        { skip: (page - 1) * limit, limit, sort: "createdAt" },
      );
      return {
        actions: items.map(actionSummary),
        page,
        limit,
        total,
        hasMore: page * limit < total,
      };
    },

    async getInvoiceAction({ actionId }) {
      const action = await store.findAction(actionId);
      if (!action)
        throw new BlogToolError(
          "INVOICE_ACTION_NOT_FOUND",
          "No suggested action with this id",
        );
      const ids = [action.invoiceId, ...(action.relatedInvoiceIds || [])];
      const invoices = await store.findInvoicesByIds(ids);
      const byId = new Map(invoices.map((inv) => [String(inv._id), inv]));
      const primary = byId.get(String(action.invoiceId));
      const revisionChanged =
        !primary || revisionOf(primary) !== action.expectedRevision;
      const relatedChanged = Object.entries(action.relatedRevisions || {}).some(
        ([relatedId, rev]) => {
          const doc = byId.get(relatedId);
          return !doc || revisionOf(doc) !== rev;
        },
      );
      return {
        action: actionFull(action),
        currentState: {
          invoices: ids
            .map((value) => invoiceState(byId.get(String(value))))
            .filter(Boolean),
          missingInvoiceIds: ids
            .map(String)
            .filter((value) => !byId.has(value)),
          invoiceChangedSinceScan: revisionChanged || relatedChanged,
          wouldBeStale:
            OPEN_STATUSES.includes(action.status) &&
            (revisionChanged || relatedChanged),
        },
        recommendation:
          action.type === "REVIEW_DUPLICATE_INVOICE"
            ? DUPLICATE_RECOMMENDATION
            : null,
      };
    },

    async getInvoiceAuditHistory(args = {}) {
      const page = args.page || 1;
      const limit = Math.min(args.limit || 20, 50);
      const { items, total } = await store.listActions(
        {
          statusIn: args.status ? [args.status] : HISTORY_STATUSES,
          invoiceId: args.invoiceId,
          actionId: args.actionId,
        },
        { skip: (page - 1) * limit, limit, sort: "updatedAt" },
      );
      return {
        entries: items.map(actionFull),
        page,
        limit,
        total,
        hasMore: page * limit < total,
      };
    },
  };
};
