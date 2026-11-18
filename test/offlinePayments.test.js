import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createOfflinePaymentService } from "../src/services/offlinePayments/service.js";
import { createPreInvoiceService } from "../src/services/offlinePayments/preInvoices.js";
import { hashLinkToken } from "../src/services/offlinePayments/rules.js";
import { validateInvoicePayload } from "../src/controllers/crm/invoice.js";
import PaymentAttempt from "../src/models/paymentAttempt.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import { staffHasPermission } from "../src/middleware/permissions.js";
import preInvoiceRoutes from "../src/routes/crm/preInvoice.js";
import offlinePaymentRoutes from "../src/routes/offlinePayments.js";
import {
  applyUpdate,
  clone,
  createClock,
  matches,
} from "./support/mcpFakes.js";

// Offline payment links and pre-invoices against in-memory fakes and a fake
// PhonePe gateway: no database, no network, no real payments.

const MERCHANT = "AQUAKARTMERCHANT";
const PHONE = 9876543210;

const createStore = (clock) => {
  let counter = 0;
  const newId = () => (++counter).toString(16).padStart(24, "0");
  const tick = () => {
    clock.advance(1);
    return clock.now();
  };
  const db = {
    quotation: [],
    pre_invoice: [],
    links: [],
    attempts: [],
    invoices: [],
    users: [],
  };
  const byId = (list, id) => list.find((doc) => String(doc._id) === String(id));
  const conditional = (list, id, condition, update) => {
    const doc = byId(list, id);
    if (!doc || !matches(doc, condition)) return null;
    applyUpdate(doc, update);
    doc.updatedAt = tick();
    return clone(doc);
  };
  const duplicate = () =>
    Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  return {
    db,
    newId,
    gatewayEnabled: true,
    findSource: async (kind, id) => clone(byId(db[kind], id)) || null,
    updateSource: async (kind, id, condition, update) =>
      conditional(db[kind], id, condition, update),
    createPreInvoice: async (doc) => {
      if (db.pre_invoice.some((p) => p.preInvoiceNo === doc.preInvoiceNo))
        throw Object.assign(duplicate(), { keyPattern: { preInvoiceNo: 1 } });
      const saved = {
        _id: doc._id || newId(),
        ...clone(doc),
        createdAt: tick(),
        updatedAt: clock.now(),
      };
      db.pre_invoice.push(saved);
      return clone(saved);
    },
    lastPreInvoiceNo: async (prefix) =>
      db.pre_invoice
        .map((p) => p.preInvoiceNo)
        .filter((no) => no.startsWith(prefix))
        .sort()
        .at(-1) || null,
    listPreInvoices: async ({ skip, limit }) => ({
      items: clone(db.pre_invoice.slice(skip, skip + limit)),
      total: db.pre_invoice.length,
    }),
    createLink: async (doc) => {
      if (
        db.links.some(
          (l) =>
            l.status === "active" &&
            l.source.kind === doc.source.kind &&
            String(l.source.id) === String(doc.source.id),
        )
      )
        throw duplicate();
      const saved = {
        _id: newId(),
        userId: null,
        reviewFlags: [],
        initiateLockUntil: null,
        ...clone(doc),
        createdAt: tick(),
        updatedAt: clock.now(),
      };
      db.links.push(saved);
      return clone(saved);
    },
    findLinkByHash: async (hash) =>
      clone(db.links.find((l) => l.tokenHash === hash)) || null,
    findLinkById: async (id) => clone(byId(db.links, id)) || null,
    findLatestLink: async (kind, id) =>
      clone(
        db.links
          .filter(
            (l) => l.source.kind === kind && String(l.source.id) === String(id),
          )
          .at(-1),
      ) || null,
    updateLink: async (id, condition, update) =>
      conditional(db.links, id, condition, update),
    revokeActiveLinks: async (kind, id, { at, by, reason }) => {
      let count = 0;
      for (const link of db.links)
        if (
          link.status === "active" &&
          link.source.kind === kind &&
          String(link.source.id) === String(id)
        ) {
          Object.assign(link, {
            status: "revoked",
            revokedAt: at,
            revokedBy: by,
            revokeReason: reason,
          });
          count += 1;
        }
      return count;
    },
    createAttempt: async (doc) => {
      const saved = {
        _id: newId(),
        ...clone(doc),
        createdAt: tick(),
        updatedAt: clock.now(),
      };
      db.attempts.push(saved);
      return clone(saved);
    },
    findAttempt: async (id) => clone(byId(db.attempts, id)) || null,
    findAttemptsForLink: async (linkId) =>
      clone(
        db.attempts
          .filter((a) => String(a.paymentLinkId) === String(linkId))
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    updateAttempt: async (id, condition, update) =>
      conditional(db.attempts, id, condition, update),
    isGatewayEnabled: async function isGatewayEnabled() {
      return this.gatewayEnabled;
    },
    findInvoiceById: async (id) => clone(byId(db.invoices, id)) || null,
    findInvoiceBySource: async (kind, id) =>
      clone(
        db.invoices.find((inv) =>
          kind === "pre_invoice"
            ? String(inv.sourcePreInvoiceId) === String(id)
            : String(inv.sourceQuotationId) === String(id),
        ),
      ) || null,
    setInvoiceOwner: async (invoiceId, firebaseUid) => {
      const invoice = byId(db.invoices, invoiceId);
      if (invoice && !invoice.firebaseUid) invoice.firebaseUid = firebaseUid;
    },
    findUserById: async (id) => clone(byId(db.users, id)) || null,
    findUserByPhone: async (phone, excludeId) =>
      clone(
        db.users.find(
          (u) =>
            u.phone === Number(phone) && String(u._id) !== String(excludeId),
        ),
      ) || null,
    updateUser: async (id, update) => {
      applyUpdate(byId(db.users, id), update);
    },
  };
};

const setup = () => {
  const clock = createClock("2026-11-18T05:00:00.000Z");
  const store = createStore(clock);
  const audits = [];
  const gateway = {
    created: [],
    results: new Map(),
    failCreate: false,
    merchantId: () => MERCHANT,
    async create(args) {
      if (this.failCreate) throw new Error("gateway down");
      this.created.push(clone(args));
      return {
        redirectUrl: `https://mercury.phonepe.test/pay/${args.transactionId}`,
        transactionId: args.transactionId,
        raw: { success: true },
      };
    },
    async verify(transactionId) {
      const attempt = store.db.attempts.find(
        (a) => a.merchantTransactionId === transactionId,
      );
      const preset = this.results.get(transactionId) || { status: "pending" };
      return {
        status: preset.status,
        amount: preset.amount ?? attempt?.amount ?? 0,
        merchantId: preset.merchantId ?? MERCHANT,
        merchantTransactionId: preset.merchantTransactionId ?? transactionId,
        gatewayTransactionId: `T${transactionId}`,
        paymentInstrumentType: "UPI_INTENT",
        raw: { code: preset.status },
      };
    },
  };
  const writer = {
    persisted: 0,
    outOfStock: false,
    validate: (payload) => validateInvoicePayload(payload),
    stockError: () =>
      Object.assign(new Error("Insufficient CRM stock"), { statusCode: 400 }),
    async assertStock() {
      if (this.outOfStock) throw this.stockError();
    },
    async persist(payload) {
      if (this.outOfStock) throw this.stockError();
      if (
        payload.sourcePreInvoiceId &&
        store.db.invoices.some(
          (inv) =>
            String(inv.sourcePreInvoiceId) ===
            String(payload.sourcePreInvoiceId),
        )
      )
        throw Object.assign(new Error("E11000"), { code: 11000 });
      this.persisted += 1;
      const invoice = {
        _id: store.newId(),
        invoiceNo: `AQB-TEST-${this.persisted}`,
        ...clone(payload),
      };
      store.db.invoices.push(invoice);
      return { invoice: clone(invoice) };
    },
  };
  const payments = createOfflinePaymentService({
    store,
    gateway,
    invoiceWriter: writer,
    config: {
      publicBaseUrl: "https://aquakart.co.in",
      linkTtlHours: 72,
      attemptTtlMinutes: 15,
    },
    audit: async (entry) => audits.push(clone(entry)),
    now: clock.now,
    log: { error() {} },
  });
  const preInvoices = createPreInvoiceService({
    store,
    payments,
    audit: async (entry) => audits.push(clone(entry)),
    now: clock.now,
  });
  const admin = { _id: "a00000000000000000000001" };
  return {
    clock,
    store,
    gateway,
    writer,
    payments,
    preInvoices,
    audits,
    admin,
  };
};

const addQuotation = (env, extra = {}) => {
  const doc = {
    _id: env.store.newId(),
    quotationNo: `AQUO|20261118|000${env.store.db.quotation.length + 1}`,
    customerDetails: {
      name: "Ravi Kumar",
      phone: PHONE,
      email: "ravi@example.com",
      address: "",
    },
    products: [
      {
        productId: "5f0000000000000000000001",
        productName: "Auto Softener 25L",
        productDescription: "Automatic softener",
        productQuantity: 1,
        productPrice: 30000,
        productDiscount: 2000,
        productTax: 0,
        productTotal: 28000,
      },
      {
        productName: "Installation",
        productQuantity: 1,
        productPrice: 1500,
        productDiscount: 0,
        productTax: 0,
        productTotal: 1500,
      },
    ],
    subTotal: 29500,
    discount: 500,
    tax: 0,
    totalAmount: 29000,
    currency: "INR",
    status: "Sent",
    payment: { status: "Unpaid", amountPaid: 0 },
    notes: "internal note",
    terms: "internal terms",
    createdBy: "a00000000000000000000009",
    ...extra,
  };
  env.store.db.quotation.push(doc);
  return doc;
};
const addUser = (env, extra = {}) => {
  const user = {
    _id: env.store.newId(),
    firebaseUid: `fb-${env.store.db.users.length + 1}`,
    addresses: [
      {
        street: "Old house 1",
        city: "Vizag",
        state: "AP",
        postalCode: "530001",
      },
    ],
    selectedAddress: {
      street: "Old house 1",
      city: "Vizag",
      state: "AP",
      postalCode: "530001",
    },
    invoices: [],
    ...extra,
  };
  env.store.db.users.push(user);
  return user;
};
const tokenOf = (url) => url.split("/pay/")[1];
const ADDRESS = {
  address: {
    street: "Flat 402, Lake View Apartments",
    city: "Hyderabad",
    state: "Telangana",
    postalCode: "500081",
  },
  alternatePhone: "+91 91234 56789",
};
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
const linkFor = async (env, kind = "quotation", doc) =>
  env.payments.createLink({ kind, sourceId: doc._id, actor: env.admin });
const payReady = async (env, kind = "quotation", doc) => {
  const created = await linkFor(env, kind, doc);
  const token = tokenOf(created.url);
  const user = addUser(env);
  await env.payments.bindCustomer(token, { _id: user._id }, ADDRESS);
  return { token, user, created };
};
const webhook = async (env, status = "paid", extra = {}) => {
  const attempt = env.store.db.attempts.at(-1);
  env.gateway.results.set(attempt.merchantTransactionId, { status, ...extra });
  const verification = await env.gateway.verify(attempt.merchantTransactionId);
  return env.payments.processVerification(
    clone(attempt),
    verification,
    "phonepe-webhook-verified",
  );
};

// ---- Admin: links ------------------------------------------------------

test("admin creates a quotation link: token shown once, only its hash stored", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const created = await linkFor(env, "quotation", quotation);
  const token = tokenOf(created.url);
  assert.match(
    created.url,
    /^https:\/\/aquakart\.co\.in\/pay\/[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(created.amount, 29000);
  assert.equal(created.status, "active");
  const [link] = env.store.db.links;
  assert.equal(link.tokenHash, hashLinkToken(token));
  assert.equal(JSON.stringify(env.store.db.links).includes(token), false);
  assert.equal(env.store.db.quotation[0].status, "Payment Pending");
  assert.equal(JSON.stringify(env.audits).includes(token), false);
});

test("regenerating revokes the previous link; revoke endpoint revokes the active one", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const first = tokenOf((await linkFor(env, "quotation", quotation)).url);
  const second = tokenOf((await linkFor(env, "quotation", quotation)).url);
  await rejects(env.payments.publicView(first), "LINK_UNAVAILABLE");
  assert.equal((await env.payments.publicView(second)).payable, true);
  assert.deepEqual(
    await env.payments.revokeLink({
      kind: "quotation",
      sourceId: quotation._id,
      actor: env.admin,
    }),
    { revoked: 1 },
  );
  await rejects(env.payments.publicView(second), "LINK_UNAVAILABLE");
});

test("links are refused for unpayable documents", async () => {
  const env = setup();
  for (const extra of [
    { status: "Paid" },
    { status: "Sold" },
    { status: "Converted" },
    { status: "Rejected" },
    { status: "Expired" },
    { convertedToInvoice: "f00000000000000000000001" },
    { totalAmount: 0 },
    { payment: { status: "Paid" } },
  ]) {
    const quotation = addQuotation(env, extra);
    await rejects(linkFor(env, "quotation", quotation), "NOT_PAYABLE");
  }
  const noPhone = addQuotation(env, {
    customerDetails: { name: "X", phone: 12345 },
  });
  await rejects(linkFor(env, "quotation", noPhone), "CUSTOMER_PHONE_INVALID");
  await rejects(
    env.payments.createLink({
      kind: "quotation",
      sourceId: "ffffffffffffffffffffffff",
      actor: env.admin,
    }),
    "SOURCE_NOT_FOUND",
  );
  env.store.gatewayEnabled = false;
  await rejects(
    linkFor(env, "quotation", addQuotation(env)),
    "GATEWAY_DISABLED",
  );
});

// ---- Public view -----------------------------------------------------------

test("public view returns only the allowed fields", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const view = await env.payments.publicView(
    tokenOf((await linkFor(env, "quotation", quotation)).url),
  );
  assert.deepEqual(Object.keys(view).sort(), [
    "amount",
    "currency",
    "discount",
    "documentNumber",
    "documentType",
    "expiresAt",
    "payable",
    "products",
    "requiresSignIn",
    "state",
    "subTotal",
    "tax",
  ]);
  assert.deepEqual(view.products, [
    {
      name: "Auto Softener 25L",
      description: "Automatic softener",
      quantity: 1,
    },
    { name: "Installation", description: "", quantity: 1 },
  ]);
  assert.equal(view.amount, 29000);
  const text = JSON.stringify(view);
  for (const secret of [
    String(quotation._id),
    "internal note",
    "internal terms",
    "Ravi",
    String(PHONE),
    "a00000000000000000000009",
    "5f0000000000000000000001",
  ])
    assert.equal(text.includes(secret), false, secret);
});

test("unknown, revoked and expired links all get the same response", async () => {
  const env = setup();
  const errors = [];
  const capture = (promise) =>
    promise.catch((error) =>
      errors.push({
        status: error.status,
        code: error.code,
        message: error.message,
      }),
    );
  await capture(env.payments.publicView("A".repeat(43)));
  const revoked = addQuotation(env);
  const revokedToken = tokenOf((await linkFor(env, "quotation", revoked)).url);
  await env.payments.revokeLink({
    kind: "quotation",
    sourceId: revoked._id,
    actor: env.admin,
  });
  await capture(env.payments.publicView(revokedToken));
  const expiring = addQuotation(env);
  const expiredToken = tokenOf((await linkFor(env, "quotation", expiring)).url);
  env.clock.advance(73 * 60 * 60 * 1000);
  await capture(env.payments.publicView(expiredToken));
  assert.equal(errors.length, 3);
  assert.deepEqual(errors[0], errors[1]);
  assert.deepEqual(errors[1], errors[2]);
  assert.equal(errors[0].status, 404);
});

test("a document total changed after link creation invalidates the link", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const { token, user } = await payReady(env, "quotation", quotation);
  env.store.db.quotation[0].totalAmount = 25000;
  await rejects(env.payments.publicView(token), "LINK_UNAVAILABLE");
  await rejects(
    env.payments.initiate(token, { _id: user._id }),
    "LINK_UNAVAILABLE",
  );
  // A line edit with the same total also invalidates it.
  env.store.db.quotation[0].totalAmount = 29000;
  env.store.db.quotation[0].products[1].productName = "Installation + kit";
  await rejects(env.payments.publicView(token), "LINK_UNAVAILABLE");
  // Regenerating gives a working link again.
  const fresh = tokenOf(
    (await linkFor(env, "quotation", env.store.db.quotation[0])).url,
  );
  assert.equal((await env.payments.publicView(fresh)).payable, true);
});

// ---- Customer binding --------------------------------------------------------

test("customer details: validation, append-only address, alternate phone", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const token = tokenOf((await linkFor(env, "quotation", quotation)).url);
  const user = addUser(env);
  for (const [body, field] of [
    [
      { ...ADDRESS, address: { ...ADDRESS.address, postalCode: "050081" } },
      "address.postalCode",
    ],
    [
      { ...ADDRESS, address: { ...ADDRESS.address, postalCode: "50008" } },
      "address.postalCode",
    ],
    [
      { ...ADDRESS, address: { ...ADDRESS.address, street: "x" } },
      "address.street",
    ],
    [{ ...ADDRESS, alternatePhone: "12345" }, "alternatePhone"],
    [{ ...ADDRESS, alternatePhone: "5876543210" }, "alternatePhone"],
  ]) {
    await assert.rejects(
      env.payments.bindCustomer(token, { _id: user._id }, body),
      (error) => {
        assert.equal(error.code, "VALIDATION_FAILED");
        assert.ok(error.details[field], field);
        return true;
      },
    );
  }
  assert.equal(env.store.db.links[0].userId, null);
  await env.payments.bindCustomer(token, { _id: user._id }, ADDRESS);
  const saved = env.store.db.users.find((u) => u._id === user._id);
  assert.equal(saved.addresses.length, 2);
  assert.equal(saved.addresses[0].street, "Old house 1");
  assert.equal(saved.selectedAddress.street, "Old house 1");
  assert.equal(saved.alternatePhone, "9123456789");
  // Same address again is not duplicated.
  await env.payments.bindCustomer(token, { _id: user._id }, ADDRESS);
  assert.equal(
    env.store.db.users.find((u) => u._id === user._id).addresses.length,
    2,
  );
});

test("once bound, a second signed-in user is blocked", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const { token } = await payReady(env, "quotation", quotation);
  const intruder = addUser(env);
  await rejects(
    env.payments.bindCustomer(token, { _id: intruder._id }, ADDRESS),
    "LINK_BOUND_TO_ANOTHER_USER",
  );
  await rejects(
    env.payments.initiate(token, { _id: intruder._id }),
    "LINK_BOUND_TO_ANOTHER_USER",
  );
  await rejects(
    env.payments.status(token, { _id: intruder._id }),
    "LINK_BOUND_TO_ANOTHER_USER",
  );
  assert.deepEqual(
    env.store.db.users.find((u) => u._id === intruder._id).addresses.length,
    1,
  );
});

test("document phone on another account: continue with the signed-in account and flag it, never merge", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const other = addUser(env, { phone: PHONE });
  const token = tokenOf((await linkFor(env, "quotation", quotation)).url);
  const user = addUser(env);
  const result = await env.payments.bindCustomer(
    token,
    { _id: user._id },
    ADDRESS,
  );
  assert.equal(result.flaggedForReview, true);
  assert.deepEqual(env.store.db.links[0].reviewFlags, [
    "PHONE_ON_OTHER_ACCOUNT",
  ]);
  assert.equal(String(env.store.db.links[0].userId), String(user._id));
  assert.equal(
    env.store.db.users.find((u) => u._id === user._id).phone,
    undefined,
  );
  assert.equal(
    env.store.db.users.find((u) => u._id === other._id).phone,
    PHONE,
  );
  assert.ok(
    env.audits.some((a) => a.action === "payment_link.phone_on_other_account"),
  );
  assert.equal(JSON.stringify(env.audits).includes(String(PHONE)), false);
});

// ---- Initiate ----------------------------------------------------------------

test("initiate needs customer details first and charges the database amount", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const token = tokenOf((await linkFor(env, "quotation", quotation)).url);
  const user = addUser(env);
  await rejects(
    env.payments.initiate(token, { _id: user._id }),
    "CUSTOMER_DETAILS_REQUIRED",
  );
  await env.payments.bindCustomer(token, { _id: user._id }, ADDRESS);
  const result = await env.payments.initiate(token, { _id: user._id });
  assert.equal(result.amount, 29000);
  assert.equal(result.reused, false);
  assert.equal(env.gateway.created[0].amount, 29000);
  assert.equal(
    env.gateway.created[0].redirectUrl,
    `https://aquakart.co.in/pay/${token}?return=1`,
  );
  const [attempt] = env.store.db.attempts;
  assert.equal(attempt.source, "CRM_OFFLINE");
  assert.equal(attempt.sourceKind, "quotation");
  assert.equal(String(attempt.sourceId), String(quotation._id));
  assert.equal(attempt.checkoutSessionId, undefined);
  assert.equal(attempt.status, "pending");
  assert.equal(env.payments.initiate.length, 2); // (token, user): no amount input exists
});

test("concurrent initiate creates one attempt; a pending attempt is reused, then expires", async () => {
  const env = setup();
  const { token, user } = await payReady(env, "quotation", addQuotation(env));
  const results = await Promise.allSettled([
    env.payments.initiate(token, { _id: user._id }),
    env.payments.initiate(token, { _id: user._id }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "PAYMENT_IN_PROGRESS",
  );
  assert.equal(env.store.db.attempts.length, 1);

  const again = await env.payments.initiate(token, { _id: user._id });
  assert.equal(again.reused, true);
  assert.equal(env.store.db.attempts.length, 1);

  env.clock.advance(16 * 60 * 1000);
  const fresh = await env.payments.initiate(token, { _id: user._id });
  assert.equal(fresh.reused, false);
  assert.equal(env.store.db.attempts.length, 2);
  assert.equal(env.store.db.attempts[0].status, "expired");
});

test("initiate refuses out-of-stock items before payment and handles gateway errors", async () => {
  const env = setup();
  const { token, user } = await payReady(env, "quotation", addQuotation(env));
  env.writer.outOfStock = true;
  await rejects(
    env.payments.initiate(token, { _id: user._id }),
    "OUT_OF_STOCK",
  );
  assert.equal(env.store.db.attempts.length, 0);
  env.writer.outOfStock = false;
  env.gateway.failCreate = true;
  await rejects(
    env.payments.initiate(token, { _id: user._id }),
    "GATEWAY_ERROR",
  );
  assert.equal(env.store.db.attempts[0].status, "failed");
  assert.equal(env.store.db.links[0].initiateLockUntil, null);
});

// ---- Verification and finalisation ------------------------------------------

test("paid quotation: one invoice, quotation Sold, invoice visible to the customer; duplicate webhooks are no-ops", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const { token, user } = await payReady(env, "quotation", quotation);
  await env.payments.initiate(token, { _id: user._id });
  await webhook(env, "paid");
  await webhook(env, "paid");
  await Promise.all([webhook(env, "paid"), webhook(env, "paid")]);
  assert.equal(env.writer.persisted, 1);
  const [invoice] = env.store.db.invoices;
  assert.equal(String(invoice.sourceQuotationId), String(quotation._id));
  assert.equal(invoice.paidStatus, "paid");
  assert.equal(invoice.paymentType, "upi");
  assert.equal(invoice.quotation, false);
  assert.equal(
    invoice.customerDetails.address,
    "Flat 402, Lake View Apartments, Hyderabad, Telangana, 500081",
  );
  assert.equal(
    invoice.products.reduce((sum, line) => sum + line.productPrice, 0),
    29000,
  );
  const saved = env.store.db.quotation[0];
  assert.equal(saved.status, "Sold");
  assert.equal(String(saved.convertedToInvoice), String(invoice._id));
  assert.equal(saved.payment.status, "Paid");
  assert.equal(saved.payment.amountPaid, 29000);
  assert.equal(saved.payment.mode, "UPI");
  assert.equal(env.store.db.links[0].status, "paid");
  assert.equal(env.store.db.links[0].conversion.status, "done");
  // The admin link state names the attempt to reconcile.
  const { link: adminState } = await env.payments.getLinkState({
    kind: "quotation",
    sourceId: quotation._id,
    actor: env.admin,
  });
  assert.equal(adminState.paidAttemptId, String(env.store.db.attempts[0]._id));
  // Customer can see it.
  assert.equal(invoice.firebaseUid, user.firebaseUid);
  const customer = env.store.db.users.find((u) => u._id === user._id);
  assert.deepEqual(
    customer.invoices.map((i) => String(i.invoiceId)),
    [String(invoice._id)],
  );

  const status = await env.payments.status(token, { _id: user._id });
  assert.equal(status.status, "paid");
  assert.equal(status.invoiceNo, invoice.invoiceNo);
  assert.equal(status.amountPaid, 29000);
  assert.equal(status.source, "CRM_OFFLINE");
  assert.ok(status.gatewayTransactionId);
  const view = await env.payments.publicView(token);
  assert.equal(view.payable, false);
  assert.equal(view.state, "paid");
  await rejects(
    env.payments.initiate(token, { _id: user._id }),
    "ALREADY_PAID",
  );
});

test("gateway amount, merchant or transaction mismatch never marks anything paid", async () => {
  for (const extra of [
    { amount: 1 },
    { merchantId: "SOMEONE_ELSE" },
    { merchantTransactionId: "OTHER" },
  ]) {
    const env = setup();
    const { token, user } = await payReady(env, "quotation", addQuotation(env));
    await env.payments.initiate(token, { _id: user._id });
    await rejects(webhook(env, "paid", extra), "VERIFICATION_MISMATCH");
    assert.equal(env.store.db.attempts[0].status, "pending");
    assert.equal(env.store.db.links[0].status, "active");
    assert.equal(env.store.db.quotation[0].payment.status, "Unpaid");
    assert.equal(env.writer.persisted, 0);
  }
});

test("pending and failed payments; a failed attempt can be retried; a later failure can't undo paid", async () => {
  const env = setup();
  const { token, user } = await payReady(env, "quotation", addQuotation(env));
  await env.payments.initiate(token, { _id: user._id });
  await webhook(env, "pending");
  assert.equal(
    (await env.payments.status(token, { _id: user._id })).status,
    "pending",
  );
  await webhook(env, "failed");
  assert.equal(env.store.db.attempts[0].status, "failed");
  assert.equal(env.store.db.links[0].status, "active");
  const retry = await env.payments.initiate(token, { _id: user._id });
  assert.equal(retry.reused, false);
  await webhook(env, "paid");
  await webhook(env, "failed");
  assert.equal(env.store.db.attempts[1].status, "paid");
  assert.equal(env.writer.persisted, 1);
});

test("refunded attempts are never flipped back to paid", async () => {
  const env = setup();
  const { token, user } = await payReady(env, "quotation", addQuotation(env));
  await env.payments.initiate(token, { _id: user._id });
  env.store.db.attempts[0].status = "refunded";
  await webhook(env, "paid");
  assert.equal(env.store.db.attempts[0].status, "refunded");
  assert.equal(env.writer.persisted, 0);
});

test("two successful payments for one link: second is flagged, still one invoice", async () => {
  const env = setup();
  const { token, user } = await payReady(env, "quotation", addQuotation(env));
  await env.payments.initiate(token, { _id: user._id });
  env.clock.advance(16 * 60 * 1000);
  await env.payments.initiate(token, { _id: user._id });
  const [first, second] = env.store.db.attempts;
  env.gateway.results.set(first.merchantTransactionId, { status: "paid" });
  env.gateway.results.set(second.merchantTransactionId, { status: "paid" });
  await env.payments.processVerification(
    clone(second),
    await env.gateway.verify(second.merchantTransactionId),
    "webhook",
  );
  await env.payments.processVerification(
    clone(first),
    await env.gateway.verify(first.merchantTransactionId),
    "webhook",
  );
  assert.equal(env.writer.persisted, 1);
  assert.ok(env.store.db.links[0].reviewFlags.includes("DUPLICATE_PAYMENT"));
});

test("stock short at payment time: payment kept, conversion blocked, retry creates exactly one invoice", async () => {
  const env = setup();
  const { token, user } = await payReady(env, "quotation", addQuotation(env));
  await env.payments.initiate(token, { _id: user._id });
  env.writer.outOfStock = true;
  await webhook(env, "paid");
  assert.equal(env.store.db.attempts[0].status, "paid");
  assert.equal(env.store.db.quotation[0].payment.status, "Paid");
  assert.equal(env.store.db.links[0].conversion.status, "blocked_stock");
  assert.equal(env.store.db.invoices.length, 0);
  env.writer.outOfStock = false;
  await env.payments.retryConversion(clone(env.store.db.attempts[0]));
  await webhook(env, "paid");
  assert.equal(env.store.db.invoices.length, 1);
  assert.equal(env.store.db.links[0].conversion.status, "done");
});

// ---- Pre-invoices --------------------------------------------------------------

test("pre-invoice created directly: server-side totals, own number series, client totals ignored", async () => {
  const env = setup();
  const { preInvoice } = await env.preInvoices.create(
    {
      customerDetails: { name: "Asha", phone: "+91 98765 43210" },
      products: [
        {
          productName: "RO Purifier",
          productQuantity: 2,
          productPrice: 10000,
          productDiscount: 1000,
          productTax: 0,
        },
      ],
      discount: 500,
      tax: 900,
      totalAmount: 1,
      subTotal: 1,
    },
    env.admin,
  );
  assert.match(preInvoice.preInvoiceNo, /^AQPI\|20261118\|0001$/);
  assert.equal(preInvoice.subTotal, 19000);
  assert.equal(preInvoice.totalAmount, 19400);
  assert.equal(preInvoice.status, "Draft");
  const second = await env.preInvoices.create(
    {
      customerDetails: { name: "B", phone: "9876543211" },
      products: [
        { productName: "Filter", productQuantity: 1, productPrice: 500 },
      ],
    },
    env.admin,
  );
  assert.match(second.preInvoice.preInvoiceNo, /\|0002$/);
  await assert.rejects(
    env.preInvoices.create(
      { customerDetails: { name: "", phone: "1" }, products: [] },
      env.admin,
    ),
    (error) =>
      error.code === "VALIDATION_FAILED" &&
      Boolean(error.details["customerDetails.phone"]) &&
      Boolean(error.details.products),
  );
});

test("move quotation to pre-invoice: lines and totals copied, second move blocked, quotation link revoked", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const quotationToken = tokenOf(
    (await linkFor(env, "quotation", quotation)).url,
  );
  const moved = await env.preInvoices.moveFromQuotation(
    quotation._id,
    env.admin,
  );
  const pre = moved.preInvoice;
  assert.equal(moved.quotationLinksRevoked, 1);
  assert.equal(pre.totalAmount, 29000);
  assert.equal(pre.products.length, 2);
  assert.equal(String(pre.sourceQuotationId), String(quotation._id));
  assert.equal(pre.sourceQuotationNo, quotation.quotationNo);
  const savedQuotation = env.store.db.quotation[0];
  assert.equal(String(savedQuotation.convertedToPreInvoice), String(pre._id));
  assert.equal(savedQuotation.convertedToPreInvoiceNo, pre.preInvoiceNo);
  assert.equal(savedQuotation.status, "Converted");
  assert.equal(savedQuotation.whatsapp.followUpEnabled, false);
  await rejects(env.payments.publicView(quotationToken), "LINK_UNAVAILABLE");
  await assert.rejects(
    env.preInvoices.moveFromQuotation(quotation._id, env.admin),
    (error) =>
      error.code === "QUOTATION_ALREADY_MOVED" &&
      error.details.preInvoiceNo === pre.preInvoiceNo,
  );
  await assert.rejects(
    linkFor(env, "quotation", savedQuotation),
    (error) =>
      error.code === "USE_PRE_INVOICE" &&
      error.details.preInvoiceId === String(pre._id) &&
      error.details.preInvoiceNo === pre.preInvoiceNo,
  );
  assert.equal(env.store.db.pre_invoice.length, 1);
});

test("paying a pre-invoice: one final invoice linked to the pre-invoice and its quotation", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const { preInvoice } = await env.preInvoices.moveFromQuotation(
    quotation._id,
    env.admin,
  );
  const { token, user } = await payReady(env, "pre_invoice", preInvoice);
  assert.equal(env.store.db.pre_invoice[0].status, "Payment Pending");
  await env.payments.initiate(token, { _id: user._id });
  await Promise.all([webhook(env, "paid"), webhook(env, "paid")]);
  await webhook(env, "paid");
  assert.equal(env.store.db.invoices.length, 1);
  const [invoice] = env.store.db.invoices;
  assert.equal(String(invoice.sourcePreInvoiceId), String(preInvoice._id));
  assert.equal(invoice.sourcePreInvoiceNo, preInvoice.preInvoiceNo);
  assert.equal(String(invoice.sourceQuotationId), String(quotation._id));
  const pre = env.store.db.pre_invoice[0];
  assert.equal(pre.status, "Converted");
  assert.equal(pre.payment.status, "Paid");
  assert.equal(String(pre.convertedToInvoice), String(invoice._id));
  const q = env.store.db.quotation[0];
  assert.equal(q.status, "Sold");
  assert.equal(String(q.convertedToInvoice), String(invoice._id));
  assert.equal(invoice.firebaseUid, user.firebaseUid);
  const status = await env.payments.status(token, { _id: user._id });
  assert.equal(status.preInvoiceNo, preInvoice.preInvoiceNo);
  assert.equal(status.quotationNo, quotation.quotationNo);
  assert.equal(status.invoiceReady, true);
});

test("both kinds go through the same adapter interface", () => {
  const env = setup();
  const keys = (adapter) =>
    Object.keys(adapter)
      .filter((key) => key !== "kind")
      .sort();
  assert.deepEqual(
    keys(env.payments.adapters.quotation),
    keys(env.payments.adapters.pre_invoice),
  );
  for (const name of ["load", "isPayable", "payableSnapshot", "markPaid"])
    assert.equal(typeof env.payments.adapters.pre_invoice[name], "function");
});

test("pre-invoice total changed after payment started: payment recorded, no invoice, flagged", async () => {
  const env = setup();
  const { preInvoice } = await env.preInvoices.create(
    {
      customerDetails: { name: "Asha", phone: "9876543210" },
      products: [
        { productName: "RO", productQuantity: 1, productPrice: 12000 },
      ],
    },
    env.admin,
  );
  const { token, user } = await payReady(env, "pre_invoice", preInvoice);
  await env.payments.initiate(token, { _id: user._id });
  await env.preInvoices.update(
    preInvoice._id,
    {
      products: [
        { productName: "RO", productQuantity: 1, productPrice: 15000 },
      ],
    },
    env.admin,
  );
  await webhook(env, "paid");
  assert.equal(env.store.db.attempts[0].status, "paid");
  assert.equal(env.store.db.invoices.length, 0);
  assert.equal(env.store.db.pre_invoice[0].payment.status, "Unpaid");
  assert.equal(env.store.db.links[0].conversion.status, "needs_review");
  assert.ok(
    env.store.db.links[0].reviewFlags.includes("AMOUNT_CHANGED_AFTER_PAYMENT"),
  );
});

test("pre-invoice edits are blocked once paid; cancelling revokes the link and frees the quotation", async () => {
  const env = setup();
  const quotation = addQuotation(env);
  const { preInvoice } = await env.preInvoices.moveFromQuotation(
    quotation._id,
    env.admin,
  );
  const token = tokenOf((await linkFor(env, "pre_invoice", preInvoice)).url);
  await env.preInvoices.update(
    preInvoice._id,
    { status: "Cancelled" },
    env.admin,
  );
  await rejects(env.payments.publicView(token), "LINK_UNAVAILABLE");
  const q = env.store.db.quotation[0];
  assert.equal(q.convertedToPreInvoice, null);
  assert.equal(q.convertedToPreInvoiceNo, null);
  assert.equal(q.status, "Sent");
  const again = await env.preInvoices.moveFromQuotation(
    quotation._id,
    env.admin,
  );
  const paid = await payReady(env, "pre_invoice", again.preInvoice);
  await env.payments.initiate(paid.token, { _id: paid.user._id });
  await webhook(env, "paid");
  await rejects(
    env.preInvoices.update(again.preInvoice._id, { discount: 10 }, env.admin),
    "PRE_INVOICE_LOCKED",
  );
});

// ---- Schema, permissions and routes ------------------------------------------

test("PaymentAttempt: storefront attempts still require a checkout session; offline ones don't", () => {
  const base = {
    userId: "64b000000000000000000001",
    gateway: "phonepe",
    idempotencyKey: "k1",
    merchantTransactionId: "m1",
    amount: 100,
  };
  const ecom = new PaymentAttempt(base).validateSync();
  assert.ok(ecom?.errors?.checkoutSessionId);
  assert.equal(new PaymentAttempt(base).source, "ECOM");
  const offline = new PaymentAttempt({
    ...base,
    source: "CRM_OFFLINE",
    sourceKind: "pre_invoice",
    sourceId: "64b000000000000000000002",
    paymentLinkId: "64b000000000000000000003",
  }).validateSync();
  assert.equal(offline, undefined);
  const withSession = new PaymentAttempt({
    ...base,
    checkoutSessionId: "64b000000000000000000004",
  }).validateSync();
  assert.equal(withSession, undefined);
});

test("new permissions exist and are not granted by the old payment permissions", () => {
  for (const permission of [
    "payments.link.manage",
    "preinvoices.read",
    "preinvoices.manage",
  ])
    assert.ok(PERMISSIONS.includes(permission), permission);
  const staff = {
    role: 0,
    roleRef: {
      slug: "sales",
      isActive: true,
      permissions: ["payments.read", "payments.create", "invoices.manage"],
    },
  };
  assert.equal(staffHasPermission(staff, "payments.link.manage"), false);
  assert.equal(staffHasPermission(staff, "preinvoices.manage"), false);
  assert.equal(staffHasPermission({ role: 1 }, "payments.link.manage"), true);
});

test("routes: admin endpoints need a staff token; customer endpoints need Google sign-in; bad tokens 404", async () => {
  const app = express();
  app.use(express.json());
  app.use("/v1/crm", preInvoiceRoutes);
  app.use("/v1", offlinePaymentRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const id = "64b000000000000000000001";
    for (const [method, path] of [
      ["GET", "/v1/crm/pre-invoices"],
      ["POST", "/v1/crm/pre-invoices"],
      ["PATCH", `/v1/crm/pre-invoices/${id}`],
      ["POST", `/v1/crm/quotations/${id}/pre-invoice`],
      ["POST", `/v1/crm/pre-invoices/${id}/payment-link`],
      ["DELETE", `/v1/crm/pre-invoices/${id}/payment-link`],
      ["POST", `/v1/crm/quotations/${id}/payment-link`],
      ["DELETE", `/v1/crm/quotations/${id}/payment-link`],
    ])
      assert.equal(
        (await fetch(`${base}${path}`, { method })).status,
        401,
        `${method} ${path}`,
      );
    const token = "A".repeat(43);
    for (const [method, path] of [
      ["POST", `/v1/payments/offline/${token}/customer`],
      ["POST", `/v1/payments/offline/${token}/initiate`],
      ["GET", `/v1/payments/offline/${token}/status`],
    ])
      assert.equal(
        (await fetch(`${base}${path}`, { method })).status,
        401,
        `${method} ${path}`,
      );
    const bad = await fetch(`${base}/v1/payments/offline/not-a-token`);
    assert.equal(bad.status, 404);
    assert.equal((await bad.json()).code, "LINK_UNAVAILABLE");
  } finally {
    server.close();
  }
});

test("existing quotation convert-to-invoice refuses a quotation moved to a pre-invoice", async () => {
  const { default: QuotationOperations } =
    await import("../src/controllers/crm/quotation.js");
  const { default: AquaQuotation } =
    await import("../src/models/crm/quotation.js");
  const original = AquaQuotation.findById;
  AquaQuotation.findById = async () => ({
    _id: "64b000000000000000000001",
    convertedToPreInvoice: "64b000000000000000000002",
    convertedToPreInvoiceNo: "AQPI|20261118|0001",
  });
  try {
    const res = {
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    await QuotationOperations.convertQuotationToInvoice(
      { params: { id: "64b000000000000000000001" }, body: {} },
      res,
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "QUOTATION_MOVED_TO_PRE_INVOICE");
    assert.equal(res.body.preInvoiceId, "64b000000000000000000002");
    assert.deepEqual(res.body.details, {
      preInvoiceId: "64b000000000000000000002",
      preInvoiceNo: "AQPI|20261118|0001",
    });
  } finally {
    AquaQuotation.findById = original;
  }
});
