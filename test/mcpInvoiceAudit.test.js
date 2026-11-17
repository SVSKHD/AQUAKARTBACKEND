import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInvoiceAuditTools } from "../src/services/mcp/invoiceAuditTools.js";
import { createInvoiceActionTools } from "../src/services/mcp/invoiceActionTools.js";
import {
  classifyAddress,
  compareInvoices,
  invoiceTotal,
} from "../src/services/mcp/invoiceAuditRules.js";
import { createAquakartMcpServer } from "../src/services/mcp/server.js";
import { renderConsentPage } from "../src/services/mcp/consentPage.js";
import { permittedScopes } from "../src/services/mcp/oauthProvider.js";
import {
  MCP_SCOPES,
  MCP_SCOPE_LIST,
  loadInvoiceAuditConfig,
} from "../src/services/mcp/config.js";
import { getInvoiceProductPriceTotal } from "../src/utils/invoiceAccess.js";
import {
  applyUpdate,
  clone,
  createClock,
  createMemoryStore,
  ctxFor,
  runnerFor,
} from "./support/mcpFakes.js";

// MCP invoice data-quality audit against in-memory fakes: no MongoDB.

const AUDIT = ctxFor([MCP_SCOPES.invoicesAudit, MCP_SCOPES.invoicesActions]);
const APPROVAL = { confirmed: true, note: "Approved by admin in CRM review" };

const createInvoiceStore = (clock) => {
  let counter = 0;
  const nextId = () => (++counter).toString(16).padStart(24, "0");
  const data = {
    invoices: [],
    orders: [],
    crmOrders: [],
    quotations: [],
    users: [],
    actions: [],
  };
  const tick = () => {
    clock.advance(1);
    return clock.now();
  };
  const kindOf = (inv) =>
    inv.quotation ? "quotation" : inv.po ? "po" : "invoice";
  const sameTime = (a, b) =>
    (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
  const calls = { updateInvoiceAddress: 0 };
  const store = {
    data,
    calls,
    nextId,
    addInvoice(doc) {
      const stamp = doc.createdAt ? new Date(doc.createdAt) : tick();
      const invoice = {
        _id: nextId(),
        products: [],
        createdAt: stamp,
        updatedAt: stamp,
        ...clone(doc),
      };
      invoice.createdAt = new Date(invoice.createdAt);
      invoice.updatedAt = new Date(invoice.updatedAt);
      data.invoices.push(invoice);
      return invoice;
    },
    touchInvoice(id, set) {
      const inv = data.invoices.find((item) => item._id === id);
      applyUpdate(inv, { $set: set });
      inv.updatedAt = tick();
    },
    scanInvoices: async ({
      from,
      to,
      afterId,
      limit,
      kinds,
      includeMigrated,
    }) =>
      clone(
        data.invoices
          .filter(
            (inv) =>
              inv.createdAt >= from &&
              inv.createdAt <= to &&
              kinds.includes(kindOf(inv)) &&
              (includeMigrated || !inv.migrated) &&
              (!afterId || inv._id > afterId),
          )
          .sort((a, b) => (a._id < b._id ? -1 : 1))
          .slice(0, limit),
      ),
    findInvoice: async (id) =>
      clone(data.invoices.find((inv) => inv._id === String(id))) || null,
    findInvoicesByIds: async (ids) =>
      clone(data.invoices.filter((inv) => ids.map(String).includes(inv._id))),
    findDuplicateCandidates: async (invoice, { transactionOrderIds = [] }) =>
      clone(
        data.invoices.filter(
          (other) =>
            other._id !== invoice._id &&
            ((invoice.invoiceNo && other.invoiceNo === invoice.invoiceNo) ||
              (invoice.sourceOrderId &&
                other.sourceOrderId === invoice.sourceOrderId) ||
              (invoice.sourceQuotationId &&
                other.sourceQuotationId === invoice.sourceQuotationId) ||
              (invoice.customerPhoneNormalized &&
                other.customerPhoneNormalized ===
                  invoice.customerPhoneNormalized) ||
              (other.sourceOrderId &&
                transactionOrderIds.includes(String(other.sourceOrderId)))),
        ),
      ),
    findOrder: async (id) =>
      clone(data.orders.find((order) => order._id === String(id))) || null,
    findOrdersForInvoice: async (invoiceId) => ({
      orders: clone(
        data.orders.filter((o) => o.invoiceId === String(invoiceId)),
      ),
      crmOrders: clone(
        data.crmOrders.filter((o) => o.invoiceId === String(invoiceId)),
      ),
    }),
    findOrderIdsByTransaction: async (transactionId, exclude) =>
      data.orders
        .filter(
          (o) => o.transactionId === transactionId && o._id !== String(exclude),
        )
        .map((o) => o._id),
    findQuotation: async (id) =>
      clone(data.quotations.find((q) => q._id === String(id))) || null,
    findUserByFirebaseUid: async (uid) =>
      clone(data.users.find((u) => u.firebaseUid === uid)) || null,
    findUserByPhone: async (phone) =>
      clone(data.users.find((u) => u.phone === Number(phone))) || null,
    findInvoiceAddressesByPhone: async (phone, excludeId) =>
      clone(
        data.invoices.filter(
          (inv) =>
            inv.customerPhoneNormalized === String(phone) &&
            inv._id !== String(excludeId) &&
            inv.customerDetails?.address,
        ),
      ),
    updateInvoiceAddress: async (id, updatedAt, address) => {
      calls.updateInvoiceAddress += 1;
      const inv = data.invoices.find((item) => item._id === String(id));
      if (!inv || !sameTime(inv.updatedAt, updatedAt)) return null;
      inv.customerDetails = { ...(inv.customerDetails || {}), address };
      inv.updatedAt = tick();
      return clone(inv);
    },

    findAction: async (actionId) =>
      clone(data.actions.find((a) => a.actionId === actionId)) || null,
    findActionByIssueKey: async (issueKey) =>
      clone(data.actions.find((a) => a.issueKey === issueKey)) || null,
    createAction: async (doc) => {
      if (data.actions.some((a) => a.issueKey === doc.issueKey))
        throw Object.assign(new Error("E11000"), { code: 11000 });
      const stamp = tick();
      const action = { ...clone(doc), createdAt: stamp, updatedAt: stamp };
      data.actions.push(action);
      return clone(action);
    },
    updateAction: async (actionId, update) => {
      const action = data.actions.find((a) => a.actionId === actionId);
      if (!action) return null;
      applyUpdate(action, update);
      action.updatedAt = tick();
      return clone(action);
    },
    claimAction: async (actionId, statuses, now, update) => {
      const action = data.actions.find((a) => a.actionId === actionId);
      if (
        !action ||
        !(
          statuses.includes(action.status) ||
          (action.status === "executing" &&
            new Date(action.executingUntil) < now)
        )
      )
        return null;
      applyUpdate(action, update);
      action.updatedAt = tick();
      return clone(action);
    },
    markOpenActionsStale: async (invoiceId, types, { at, note }) => {
      let count = 0;
      for (const action of data.actions)
        if (
          action.invoiceId === String(invoiceId) &&
          types.includes(action.type) &&
          ["pending_review", "approved"].includes(action.status)
        ) {
          applyUpdate(action, {
            $set: { status: "stale" },
            $push: { history: { status: "stale", at, note } },
          });
          count += 1;
        }
      return count;
    },
    listActions: async (filter, { skip, limit }) => {
      const items = data.actions.filter(
        (a) =>
          (!filter.type || a.type === filter.type) &&
          (!filter.status || a.status === filter.status) &&
          (!filter.statusIn || filter.statusIn.includes(a.status)) &&
          (!filter.actionId || a.actionId === filter.actionId) &&
          (!filter.customerKey || a.customerKey === filter.customerKey) &&
          (filter.minConfidence === undefined ||
            a.confidence >= filter.minConfidence) &&
          (filter.maxConfidence === undefined ||
            a.confidence <= filter.maxConfidence) &&
          (!filter.invoiceId ||
            a.invoiceId === filter.invoiceId ||
            (a.relatedInvoiceIds || []).map(String).includes(filter.invoiceId)),
      );
      return {
        items: clone(items.slice(skip, skip + limit)),
        total: items.length,
      };
    },
  };
  return store;
};

const setup = (configOverrides = {}) => {
  const clock = createClock("2026-11-17T04:00:00.000Z");
  const store = createInvoiceStore(clock);
  const audits = [];
  const config = {
    invoiceAudit: { ...loadInvoiceAuditConfig({}), ...configOverrides },
  };
  const auditTools = createInvoiceAuditTools({
    store,
    config,
    now: clock.now,
  });
  const actionTools = createInvoiceActionTools({
    store,
    runOperation: runnerFor(createMemoryStore(clock), clock),
    config,
    audit: async (entry) => audits.push(clone(entry)),
    now: clock.now,
  });
  return { clock, store, audits, auditTools, actionTools };
};

const PHONE = "9876543210";
const line = (productId, productQuantity, productPrice) => ({
  productId,
  productName: `Product ${productId}`,
  productQuantity,
  productPrice,
});
const P1 = "5f0000000000000000000001";
const P2 = "5f0000000000000000000002";
const invoiceDoc = (extra = {}) => ({
  invoiceNo: `AQ-${Math.random().toString(36).slice(2, 8)}`,
  date: "2026-11-10",
  customerDetails: {
    name: "Test Customer",
    phone: Number(PHONE),
    address: null,
  },
  customerPhoneNormalized: PHONE,
  products: [line(P1, 1, 25000)],
  migrated: false,
  ...extra,
});
const ADDRESS_ORDER = {
  street: "12 Lake View Road",
  city: "Hyderabad",
  state: "Telangana",
  postalCode: "500081",
};
const ORDER_TEXT = "12 Lake View Road, Hyderabad, Telangana, 500081";
const scanAll = (tools, extra = {}) =>
  tools.auditInvoices({ from: "2026-01-01", to: "2026-11-30", ...extra });
const actionsOf = (store, type) =>
  store.data.actions.filter((action) => !type || action.type === type);
const rejects = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
};

// ---- Rules -------------------------------------------------------------

test("classifyAddress: null, empty, whitespace, placeholders, incomplete", () => {
  assert.equal(classifyAddress(null), "missing");
  assert.equal(classifyAddress(undefined), "missing");
  assert.equal(classifyAddress(""), "missing");
  assert.equal(classifyAddress("   \n "), "missing");
  for (const value of [
    "N/A",
    "n.a.",
    "-",
    "--",
    "nil",
    "NONE",
    "Not available",
    "0",
  ])
    assert.equal(classifyAddress(value), "placeholder", value);
  assert.equal(classifyAddress("Hyd"), "incomplete");
  assert.equal(classifyAddress(ORDER_TEXT), "ok");
});

test("invoiceTotal reuses the existing invoice total logic", () => {
  const invoice = { products: [line(P1, 2, 1000), line(P2, 1, 500)] };
  assert.equal(invoiceTotal(invoice), getInvoiceProductPriceTotal(invoice));
});

// ---- Missing addresses ------------------------------------------------

test("scan: null address filled from the same source order; scan never changes invoices", async () => {
  const { store, auditTools } = setup();
  const orderId = store.nextId();
  store.data.orders.push({
    _id: orderId,
    orderId: "ORD-1",
    shippingAddress: ADDRESS_ORDER,
    transactionId: "T-1",
  });
  const invoice = store.addInvoice(
    invoiceDoc({ sourceOrderId: orderId, createdAt: "2026-11-10T05:00:00Z" }),
  );
  const before = clone(store.data.invoices);
  const result = await scanAll(auditTools);
  assert.deepEqual(store.data.invoices, before);
  assert.equal(result.invoicesChanged, 0);
  assert.equal(result.summary.missingAddress, 1);
  const [action] = actionsOf(store, "FILL_MISSING_ADDRESS");
  assert.equal(action.invoiceId, invoice._id);
  assert.equal(action.suggestedValue, ORDER_TEXT);
  assert.equal(action.confidence, 0.95);
  assert.equal(action.evidence.source, "linked_order_shipping");
  assert.equal(action.evidence.fromLinkedTransaction, true);
  assert.equal(action.status, "pending_review");
  assert.equal(action.requiresApproval, true);
  assert.equal(
    action.expectedRevision,
    new Date(invoice.updatedAt).toISOString(),
  );
});

test("scan: empty, whitespace and N/A addresses are detected", async () => {
  const { store, auditTools } = setup();
  for (const address of ["", "   ", "N/A"])
    store.addInvoice(
      invoiceDoc({
        customerDetails: { name: "X", address },
        customerPhoneNormalized: undefined,
        createdAt: "2026-11-10T05:00:00Z",
      }),
    );
  const result = await scanAll(auditTools, { issueTypes: ["missing_address"] });
  assert.equal(result.summary.missingAddress, 3);
  assert.equal(actionsOf(store, "REQUEST_ADDRESS").length, 3);
});

test("scan: multiple addresses for one customer -> no automatic choice; reviewer picks a candidate", async () => {
  const { store, auditTools, actionTools } = setup();
  store.data.users.push({
    _id: store.nextId(),
    phone: Number(PHONE),
    addresses: [
      ADDRESS_ORDER,
      {
        street: "Plot 7 Jubilee Hills",
        city: "Hyderabad",
        state: "Telangana",
        postalCode: "500033",
      },
    ],
  });
  store.addInvoice(invoiceDoc({ createdAt: "2026-11-10T05:00:00Z" }));
  await scanAll(auditTools, { issueTypes: ["missing_address"] });
  const [action] = actionsOf(store, "FILL_MISSING_ADDRESS");
  assert.equal(action.suggestedValue, null);
  assert.equal(action.candidates.length, 2);
  assert.equal(action.evidence.requiresManualConfirmation, true);
  assert.equal(action.evidence.matchedPhone, true);
  assert.equal(action.confidence, 0);
  await rejects(
    actionTools.executeInvoiceAction(
      {
        idempotencyKey: "exec-multi-1",
        actionId: action.actionId,
        expectedRevision: action.expectedRevision,
        approval: APPROVAL,
      },
      AUDIT,
    ),
    "CANDIDATE_REQUIRED",
  );
  const chosen = action.candidates[1];
  const done = await actionTools.executeInvoiceAction(
    {
      idempotencyKey: "exec-multi-2",
      actionId: action.actionId,
      expectedRevision: action.expectedRevision,
      candidateId: chosen.candidateId,
      approval: APPROVAL,
    },
    AUDIT,
  );
  assert.equal(done.action.status, "executed");
  assert.equal(store.data.invoices[0].customerDetails.address, chosen.value);
});

test("scan: conflicting linked order and quotation addresses -> conflict, no suggestion", async () => {
  const { store, auditTools } = setup();
  const orderId = store.nextId();
  const quotationId = store.nextId();
  store.data.orders.push({ _id: orderId, shippingAddress: ADDRESS_ORDER });
  store.data.quotations.push({
    _id: quotationId,
    quotationNo: "Q-1",
    customerDetails: {
      address: "44 Banjara Hills Road No 2, Hyderabad 500034",
    },
  });
  store.addInvoice(
    invoiceDoc({
      sourceOrderId: orderId,
      sourceQuotationId: quotationId,
      createdAt: "2026-11-10T05:00:00Z",
    }),
  );
  await scanAll(auditTools, { issueTypes: ["missing_address"] });
  const [action] = actionsOf(store, "FILL_MISSING_ADDRESS");
  assert.equal(action.evidence.conflict, true);
  assert.equal(action.suggestedValue, null);
  assert.equal(action.candidates.length, 2);
});

test("scan: missing source references -> phone history only, manual confirmation, lower confidence", async () => {
  const { store, auditTools } = setup();
  store.addInvoice(
    invoiceDoc({
      customerDetails: { name: "X", phone: Number(PHONE), address: ORDER_TEXT },
      createdAt: "2025-06-01T05:00:00Z",
      date: "2025-06-01",
    }),
  );
  store.addInvoice(invoiceDoc({ createdAt: "2026-11-10T05:00:00Z" }));
  await scanAll(auditTools, { issueTypes: ["missing_address"] });
  const [action] = actionsOf(store, "FILL_MISSING_ADDRESS");
  assert.equal(action.suggestedValue, ORDER_TEXT);
  assert.equal(action.confidence, 0.45);
  assert.equal(action.evidence.source, "phone_invoice_history");
  assert.equal(action.evidence.requiresManualConfirmation, true);
  assert.equal(action.evidence.fromLinkedTransaction, false);
});

test("scan: no reliable address -> REQUEST_ADDRESS; executing it is refused", async () => {
  const { store, auditTools, actionTools } = setup();
  store.addInvoice(invoiceDoc({ createdAt: "2026-11-10T05:00:00Z" }));
  await scanAll(auditTools, { issueTypes: ["missing_address"] });
  const [action] = actionsOf(store, "REQUEST_ADDRESS");
  assert.equal(action.executable, false);
  assert.equal(action.suggestedValue, null);
  await rejects(
    actionTools.executeInvoiceAction(
      {
        idempotencyKey: "exec-request-1",
        actionId: action.actionId,
        expectedRevision: action.expectedRevision,
        approval: APPROVAL,
      },
      AUDIT,
    ),
    "MANUAL_REVIEW_REQUIRED",
  );
  assert.equal(store.calls.updateInvoiceAddress, 0);
});

// ---- Duplicates -------------------------------------------------------

const withAddress = (extra = {}) =>
  invoiceDoc({
    customerDetails: { name: "X", phone: Number(PHONE), address: ORDER_TEXT },
    ...extra,
  });

test("duplicates: repeated invoice number", async () => {
  const { store, auditTools } = setup();
  const a = store.addInvoice(
    withAddress({
      invoiceNo: "AQ-100",
      createdAt: "2026-11-01T05:00:00Z",
      date: "2026-11-01",
    }),
  );
  const b = store.addInvoice(
    withAddress({
      invoiceNo: "AQ-100",
      customerPhoneNormalized: "9123456780",
      products: [line(P2, 3, 900)],
      createdAt: "2026-11-05T05:00:00Z",
      date: "2026-11-05",
    }),
  );
  const result = await scanAll(auditTools, { issueTypes: ["duplicates"] });
  assert.equal(result.summary.duplicatePairs, 1);
  const [action] = actionsOf(store, "REVIEW_DUPLICATE_INVOICE");
  assert.equal(action.invoiceId, a._id);
  assert.deepEqual(action.relatedInvoiceIds, [b._id]);
  assert.equal(action.evidence.sameInvoiceNo, true);
  assert.equal(action.suggestedAction, "REVIEW_FOR_RECONCILIATION");
  assert.equal(action.executable, false);
});

test("duplicates: same customer with legitimate repeat purchases is not flagged", async () => {
  const { store, auditTools } = setup();
  // Same phone, products and total, a month apart.
  store.addInvoice(
    withAddress({ createdAt: "2026-10-01T05:00:00Z", date: "2026-10-01" }),
  );
  store.addInvoice(
    withAddress({ createdAt: "2026-11-01T05:00:00Z", date: "2026-11-01" }),
  );
  // Same phone and same total but different products, same day.
  store.addInvoice(
    withAddress({
      products: [line(P2, 1, 25000)],
      createdAt: "2026-11-01T06:00:00Z",
      date: "2026-11-01",
    }),
  );
  const result = await scanAll(auditTools, { issueTypes: ["duplicates"] });
  assert.equal(result.summary.duplicatePairs, 0);
  assert.equal(actionsOf(store).length, 0);
});

test("duplicates: same source order and same payment transaction", async () => {
  const { store, auditTools } = setup();
  const orderA = store.nextId();
  const orderB = store.nextId();
  const orderC = store.nextId();
  store.data.orders.push(
    { _id: orderA, transactionId: "TXN-1" },
    { _id: orderB, transactionId: "TXN-2" },
    { _id: orderC, transactionId: "TXN-2" },
  );
  store.addInvoice(
    withAddress({
      sourceOrderId: orderA,
      customerPhoneNormalized: "9000000001",
      createdAt: "2026-11-01T05:00:00Z",
    }),
  );
  store.addInvoice(
    withAddress({
      sourceOrderId: orderA,
      customerPhoneNormalized: "9000000002",
      createdAt: "2026-11-03T05:00:00Z",
    }),
  );
  store.addInvoice(
    withAddress({
      sourceOrderId: orderB,
      customerPhoneNormalized: "9000000003",
      createdAt: "2026-11-04T05:00:00Z",
    }),
  );
  store.addInvoice(
    withAddress({
      sourceOrderId: orderC,
      customerPhoneNormalized: "9000000004",
      createdAt: "2026-11-05T05:00:00Z",
    }),
  );
  await scanAll(auditTools, { issueTypes: ["duplicates"] });
  const actions = actionsOf(store, "REVIEW_DUPLICATE_INVOICE");
  assert.equal(actions.length, 2);
  assert.ok(actions.some((a) => a.evidence.sameSourceOrder));
  const txn = actions.find((a) => a.evidence.sameTransactionRef);
  assert.ok(txn);
  assert.equal(txn.evidence.sameSourceOrder, false);
});

test("duplicates: close-in-time window uses the invoice's own date, not createdAt", async () => {
  const { store, auditTools } = setup();
  // Entered 20 days apart, but both dated 2026-11-02 / 2026-11-03.
  store.addInvoice(
    withAddress({ createdAt: "2026-11-02T05:00:00Z", date: "02/11/2026" }),
  );
  store.addInvoice(
    withAddress({ createdAt: "2026-11-22T05:00:00Z", date: "2026-11-03" }),
  );
  // Entered minutes apart, but dated 10 days apart: not a duplicate.
  store.addInvoice(
    withAddress({
      customerPhoneNormalized: "9111111111",
      createdAt: "2026-11-10T05:00:00Z",
      date: "2026-11-01",
    }),
  );
  store.addInvoice(
    withAddress({
      customerPhoneNormalized: "9111111111",
      createdAt: "2026-11-10T05:05:00Z",
      date: "2026-11-11",
    }),
  );
  await scanAll(auditTools, { issueTypes: ["duplicates"] });
  const actions = actionsOf(store, "REVIEW_DUPLICATE_INVOICE");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].evidence.withinWindow, true);
  assert.equal(actions[0].evidence.daysApart, 1);
  assert.deepEqual(actions[0].confidenceBasis.sort(), [
    "samePhone",
    "sameProducts",
    "sameTotal",
    "withinWindow",
  ]);
  assert.equal(actions[0].confidence, 0.5);
});

test("duplicates: migrated invoices are handled separately and not flagged by default", async () => {
  const { store, auditTools } = setup();
  const twin = { createdAt: "2026-11-05T05:00:00Z", date: "2026-11-05" };
  store.addInvoice(withAddress({ ...twin, invoiceNo: "MIG-1" }));
  store.addInvoice(
    withAddress({ ...twin, invoiceNo: "MIG-1", migrated: true }),
  );
  store.addInvoice(
    withAddress({ ...twin, invoiceNo: "MIG-2", migrated: true }),
  );
  store.addInvoice(
    withAddress({ ...twin, invoiceNo: "MIG-3", migrated: true }),
  );
  let result = await scanAll(auditTools);
  assert.equal(result.summary.duplicatePairs, 0);
  assert.equal(result.summary.migratedScanned, 0);
  assert.equal(actionsOf(store).length, 0);

  // Opt in: migrated vs migrated, invoice number only. MIG-2/MIG-3 share
  // phone, products, total and date but are not flagged.
  store.addInvoice(
    withAddress({ ...twin, invoiceNo: "MIG-2", migrated: true }),
  );
  result = await scanAll(auditTools, { includeMigrated: true });
  const actions = actionsOf(store, "REVIEW_DUPLICATE_INVOICE");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].migrated, true);
  assert.equal(actions[0].evidence.sameInvoiceNo, true);
  assert.equal(actions[0].evidence.samePhone, false);
  assert.equal(actions[0].evidence.migrated, true);
  assert.equal(actions[0].invoiceNo, "MIG-2");
});

test("duplicates: a quotation document and the invoice made from it are not duplicates", async () => {
  const { store, auditTools } = setup();
  const quotationId = store.nextId();
  const same = {
    createdAt: "2026-11-05T05:00:00Z",
    date: "2026-11-05",
    invoiceNo: "AQ-Q1",
  };
  store.addInvoice(
    withAddress({ ...same, quotation: true, sourceQuotationId: quotationId }),
  );
  store.addInvoice(withAddress({ ...same, sourceQuotationId: quotationId }));
  store.addInvoice(withAddress({ ...same, po: true }));
  let result = await scanAll(auditTools);
  assert.equal(result.summary.scanned, 1);
  assert.equal(result.summary.duplicatePairs, 0);
  result = await scanAll(auditTools, {
    documentKinds: ["invoice", "po", "quotation"],
  });
  assert.equal(result.summary.scanned, 3);
  assert.equal(result.summary.duplicatePairs, 0);
  assert.equal(actionsOf(store).length, 0);

  // Two PO documents with the same number are compared with each other.
  store.addInvoice(withAddress({ ...same, po: true }));
  await scanAll(auditTools, { documentKinds: ["po"] });
  const [action] = actionsOf(store, "REVIEW_DUPLICATE_INVOICE");
  assert.equal(action.documentKind, "po");
});

test("compareInvoices: unknown invoice dates never satisfy the time window", () => {
  const a = { _id: "a", ...withAddress({ date: "" }) };
  const b = { _id: "b", ...withAddress({ date: "not a date" }) };
  assert.equal(compareInvoices(a, b), null);
});

test("duplicate suggestions are never executable", async () => {
  const { store, auditTools, actionTools } = setup();
  store.addInvoice(
    withAddress({ invoiceNo: "AQ-7", createdAt: "2026-11-01T05:00:00Z" }),
  );
  store.addInvoice(
    withAddress({ invoiceNo: "AQ-7", createdAt: "2026-11-02T05:00:00Z" }),
  );
  await scanAll(auditTools);
  const [action] = actionsOf(store, "REVIEW_DUPLICATE_INVOICE");
  await assert.rejects(
    actionTools.executeInvoiceAction(
      {
        idempotencyKey: "exec-dup-1",
        actionId: action.actionId,
        expectedRevision: action.expectedRevision,
        approval: APPROVAL,
      },
      AUDIT,
    ),
    (error) => {
      assert.equal(error.code, "MANUAL_REVIEW_REQUIRED");
      assert.match(error.details.recommendation, /never deletes, voids/);
      return true;
    },
  );
  assert.equal(store.data.invoices.length, 2);
});

// ---- Re-scans ----------------------------------------------------------

test("re-scan refreshes the same suggestion; ignored stays ignored; dryRun saves nothing", async () => {
  const { store, auditTools, actionTools } = setup();
  store.addInvoice(
    withAddress({ invoiceNo: "AQ-8", createdAt: "2026-11-01T05:00:00Z" }),
  );
  store.addInvoice(
    withAddress({ invoiceNo: "AQ-8", createdAt: "2026-11-02T05:00:00Z" }),
  );
  const dry = await scanAll(auditTools, { dryRun: true });
  assert.equal(dry.issues.length, 1);
  assert.equal(actionsOf(store).length, 0);
  await scanAll(auditTools);
  const second = await scanAll(auditTools);
  assert.equal(second.summary.refreshed, 1);
  assert.equal(actionsOf(store).length, 1);
  const [action] = actionsOf(store);
  await actionTools.ignoreInvoiceAction(
    {
      idempotencyKey: "ignore-dup-1",
      actionId: action.actionId,
      reason: "Two separate sales",
    },
    AUDIT,
  );
  const third = await scanAll(auditTools);
  assert.equal(third.summary.unchanged, 1);
  assert.equal(actionsOf(store)[0].status, "ignored");
  assert.equal(actionsOf(store)[0].ignored.reason, "Two separate sales");
});

test("scan pagination: bounded range and cursor", async () => {
  const { store, auditTools } = setup();
  for (let i = 0; i < 5; i += 1)
    store.addInvoice(
      withAddress({
        createdAt: `2026-11-0${i + 1}T05:00:00Z`,
        date: `2026-1${i % 2}-01`,
      }),
    );
  const first = await scanAll(auditTools, { limit: 2 });
  assert.equal(first.summary.scanned, 2);
  assert.equal(first.hasMore, true);
  const next = await scanAll(auditTools, {
    limit: 10,
    cursor: first.nextCursor,
  });
  assert.equal(next.summary.scanned, 3);
  assert.equal(next.hasMore, false);
  await rejects(
    auditTools.auditInvoices({ from: "2024-01-01", to: "2026-01-01" }),
    "RANGE_TOO_LARGE",
  );
});

// ---- Execution ---------------------------------------------------------

const prepareFill = async () => {
  const env = setup();
  const orderId = env.store.nextId();
  env.store.data.orders.push({ _id: orderId, shippingAddress: ADDRESS_ORDER });
  const invoice = env.store.addInvoice(
    invoiceDoc({ sourceOrderId: orderId, createdAt: "2026-11-10T05:00:00Z" }),
  );
  await scanAll(env.auditTools, { issueTypes: ["missing_address"] });
  const [action] = actionsOf(env.store, "FILL_MISSING_ADDRESS");
  return { ...env, invoice, action };
};
const execArgs = (action, extra = {}) => ({
  idempotencyKey: "exec-fill-0001",
  actionId: action.actionId,
  expectedRevision: action.expectedRevision,
  approval: APPROVAL,
  ...extra,
});

test("execute: fills only the address, is idempotent, and is audited with before/after", async () => {
  const { store, auditTools, actionTools, audits, action, invoice } =
    await prepareFill();
  const untouched = clone(store.data.invoices[0]);
  const first = await actionTools.executeInvoiceAction(execArgs(action), AUDIT);
  assert.equal(first.replayed, false);
  assert.equal(first.action.status, "executed");
  assert.equal(first.action.execution.before, null);
  assert.equal(first.action.execution.after, ORDER_TEXT);
  const saved = store.data.invoices[0];
  assert.equal(saved.customerDetails.address, ORDER_TEXT);
  assert.equal(saved.customerDetails.name, untouched.customerDetails.name);
  assert.deepEqual(saved.products, untouched.products);
  assert.equal(saved.invoiceNo, untouched.invoiceNo);
  assert.equal(saved.date, untouched.date);

  const replay = await actionTools.executeInvoiceAction(
    execArgs(action),
    AUDIT,
  );
  assert.equal(replay.replayed, true);
  const again = await actionTools.executeInvoiceAction(
    execArgs(action, { idempotencyKey: "exec-fill-0002" }),
    AUDIT,
  );
  assert.equal(again.alreadyExecuted, true);
  assert.equal(store.calls.updateInvoiceAddress, 1);

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "mcp.invoice.fill_address");
  assert.equal(audits[0].resourceId, invoice._id);
  assert.deepEqual(audits[0].before, { "customerDetails.address": null });
  assert.deepEqual(audits[0].after, { "customerDetails.address": ORDER_TEXT });
  assert.equal(audits[0].metadata.approvalNote, APPROVAL.note);

  const history = await auditTools.getInvoiceAuditHistory({
    invoiceId: invoice._id,
  });
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].execution.after, ORDER_TEXT);
  assert.deepEqual(
    history.entries[0].history.map((entry) => entry.status),
    ["pending_review", "approved", "executing", "executed"],
  );
});

test("execute: stale suggestion is rejected when the invoice changed after the scan", async () => {
  const { store, actionTools, action, invoice } = await prepareFill();
  store.touchInvoice(invoice._id, { paidStatus: "Paid" });
  await rejects(
    actionTools.executeInvoiceAction(execArgs(action), AUDIT),
    "ACTION_STALE",
  );
  assert.equal(store.data.actions[0].status, "stale");
  assert.equal(store.data.invoices[0].customerDetails.address, null);
  await rejects(
    actionTools.executeInvoiceAction(
      execArgs(action, { idempotencyKey: "exec-fill-0003" }),
      AUDIT,
    ),
    "ACTION_STALE",
  );
});

test("execute: wrong expectedRevision and evidence that disappeared are refused", async () => {
  const { store, actionTools, action } = await prepareFill();
  await rejects(
    actionTools.executeInvoiceAction(
      execArgs(action, { expectedRevision: "2020-01-01T00:00:00.000Z" }),
      AUDIT,
    ),
    "REVISION_CONFLICT",
  );
  store.data.orders[0].shippingAddress = {};
  await rejects(
    actionTools.executeInvoiceAction(
      execArgs(action, { idempotencyKey: "exec-fill-0004" }),
      AUDIT,
    ),
    "ACTION_STALE",
  );
  assert.equal(store.calls.updateInvoiceAddress, 0);
});

test("execute: a concurrent execution is refused while one holds the claim", async () => {
  const { store, actionTools, action } = await prepareFill();
  store.data.actions[0].status = "executing";
  store.data.actions[0].executingUntil = new Date("2099-01-01");
  await rejects(
    actionTools.executeInvoiceAction(execArgs(action), AUDIT),
    "OPERATION_IN_PROGRESS",
  );
  assert.equal(store.calls.updateInvoiceAddress, 0);
});

test("re-scan after the address is filled marks open address suggestions stale", async () => {
  const { store, auditTools, action, invoice } = await prepareFill();
  store.touchInvoice(invoice._id, { "customerDetails.address": ORDER_TEXT });
  const result = await scanAll(auditTools, { issueTypes: ["missing_address"] });
  assert.equal(result.summary.staleMarked, 1);
  assert.equal(store.data.actions[0].actionId, action.actionId);
  assert.equal(store.data.actions[0].status, "stale");
});

test("get and list: current state, stale preview and filters", async () => {
  const { store, auditTools, action, invoice } = await prepareFill();
  const got = await auditTools.getInvoiceAction({ actionId: action.actionId });
  assert.equal(got.currentState.invoices[0].customerPhoneMasked, "98******10");
  assert.equal(got.currentState.wouldBeStale, false);
  assert.equal(JSON.stringify(got).includes(PHONE), false);
  store.touchInvoice(invoice._id, { paidStatus: "Paid" });
  const later = await auditTools.getInvoiceAction({
    actionId: action.actionId,
  });
  assert.equal(later.currentState.wouldBeStale, true);
  const listed = await auditTools.listInvoiceActions({
    customerPhone: `+91 ${PHONE}`,
  });
  assert.equal(listed.total, 1);
  const none = await auditTools.listInvoiceActions({ minConfidence: 0.99 });
  assert.equal(none.total, 0);
  await rejects(
    auditTools.getInvoiceAction({
      actionId: "ina_00000000-0000-0000-0000-000000000000",
    }),
    "INVOICE_ACTION_NOT_FOUND",
  );
});

// ---- MCP surface, scopes and permissions ------------------------------

const callTool = async (tools, scopes, name, args) => {
  const server = createAquakartMcpServer({
    blogTools: {},
    instagramTools: {},
    invoiceAuditTools: tools.auditTools,
    invoiceActionTools: tools.actionTools,
    auth: ctxFor(scopes).auth,
    correlationId: "test-correlation-id",
    resourceMetadataUrl: "http://localhost/.well-known/x",
    log: { log() {}, error() {} },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  let body = result.structuredContent;
  if (!body) {
    try {
      body = JSON.parse(result.content[0].text);
    } catch (_error) {
      body = { text: result.content[0].text };
    }
  }
  return { names, result, body };
};

test("MCP: invoice tools registered, scoped and approval enforced by the schema", async () => {
  const env = await prepareFill();
  const { names, body } = await callTool(
    env,
    [MCP_SCOPES.invoicesAudit],
    "aquakart_list_invoice_actions",
    {},
  );
  for (const name of [
    "aquakart_audit_invoices",
    "aquakart_list_invoice_actions",
    "aquakart_get_invoice_action",
    "aquakart_execute_invoice_action",
    "aquakart_ignore_invoice_action",
    "aquakart_get_invoice_audit_history",
  ])
    assert.ok(names.includes(name), name);
  assert.equal(body.ok, true);
  assert.equal(body.total, 1);

  // Audit-only connection cannot execute.
  const denied = await callTool(
    env,
    [MCP_SCOPES.invoicesAudit],
    "aquakart_execute_invoice_action",
    execArgs(env.action),
  );
  assert.equal(denied.body.error.code, "INSUFFICIENT_SCOPE");

  // Blog/Instagram/catalogue scopes never reach invoices.
  const other = MCP_SCOPE_LIST.filter(
    (scope) => !scope.startsWith("invoices:"),
  );
  const blocked = await callTool(
    env,
    other,
    "aquakart_list_invoice_actions",
    {},
  );
  assert.equal(blocked.body.error.code, "INSUFFICIENT_SCOPE");

  // No approval, or approval not confirmed: rejected before anything runs.
  for (const approval of [undefined, { confirmed: false, note: "nope" }]) {
    const { result } = await callTool(
      env,
      [MCP_SCOPES.invoicesActions],
      "aquakart_execute_invoice_action",
      execArgs(env.action, { approval }),
    );
    assert.equal(result.isError, true);
  }
  assert.equal(env.store.calls.updateInvoiceAddress, 0);

  const ok = await callTool(
    env,
    [MCP_SCOPES.invoicesActions],
    "aquakart_execute_invoice_action",
    execArgs(env.action),
  );
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.action.status, "executed");
});

test("permissions: invoice scopes need invoices.audit / invoices.audit.execute, not invoices.read/manage", () => {
  const staff = (permissions) => ({
    role: 0,
    roleRef: { slug: "staff", isActive: true, permissions },
  });
  const all = [MCP_SCOPES.invoicesAudit, MCP_SCOPES.invoicesActions];
  assert.deepEqual(
    permittedScopes(
      staff(["invoices.read", "invoices.manage", "blogs.manage"]),
      all,
    ),
    [],
  );
  assert.deepEqual(permittedScopes(staff(["invoices.audit"]), all), [
    MCP_SCOPES.invoicesAudit,
  ]);
  assert.deepEqual(
    permittedScopes(staff(["invoices.audit", "invoices.audit.execute"]), all),
    all,
  );
});

test("consent page: invoice scopes start unticked", () => {
  const html = renderConsentPage({
    clientName: "Test",
    scopes: [MCP_SCOPES.invoicesAudit, MCP_SCOPES.invoicesActions],
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    requestId: "r",
    action: "/v1/mcp/oauth/consent",
  });
  for (const scope of ["invoices:audit", "invoices:actions"]) {
    const match = html.match(new RegExp(`value="${scope}"[^>]*>`));
    assert.ok(match, scope);
    assert.equal(match[0].includes("checked"), false, scope);
  }
});
