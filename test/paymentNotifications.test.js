import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAmount,
  getAdminAlertPhones,
  getPaymentNotificationStatus,
  isPaymentTemplateConfigured,
  notifyPaymentLinkCreated,
  notifyPaymentLinkInvoiceReady,
  notifyPaymentLinkPaid,
  notifyStorefrontOrderPaid,
  sendPaymentTemplate,
} from "../src/services/notifications/paymentNotifications.js";
import { joinTemplateVariables } from "../src/services/notifications/fast2SmsWhatsApp.js";

const ENV = {
  FAST2SMS_API_KEY: "test-key",
  FAST2SMS_WHATSAPP_PHONE_NUMBER_ID: "123",
  FAST2SMS_SMS_ENABLED: "true",
  FAST2SMS_SMS_SENDER_ID: "AQUAKT",
  FAST2SMS_WHATSAPP_ADMIN_ORDER_MESSAGE_ID: "wa-admin",
  FAST2SMS_WHATSAPP_ORDER_CONFIRMED_MESSAGE_ID: "wa-order",
  FAST2SMS_WHATSAPP_PAYMENT_RECEIVED_MESSAGE_ID: "wa-paid",
  FAST2SMS_WHATSAPP_PAYMENT_LINK_MESSAGE_ID: "wa-link",
  FAST2SMS_SMS_ADMIN_ORDER_MESSAGE_ID: "sms-admin",
  FAST2SMS_SMS_ORDER_CONFIRMED_MESSAGE_ID: "sms-order",
  FAST2SMS_SMS_PAYMENT_RECEIVED_MESSAGE_ID: "sms-paid",
  ECOM_BASE_URL: "https://aquakart.co.in",
  INVOICE_CUSTOMER_ORIGIN: "https://aquakart.co.in",
};
const KEYS = [...Object.keys(ENV), "ORDER_ALERT_PHONES"];

const withEnv = async (overrides, fn) => {
  const previous = Object.fromEntries(
    KEYS.map((key) => [key, process.env[key]]),
  );
  KEYS.forEach((key) => delete process.env[key]);
  Object.entries({ ...ENV, ...overrides }).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
  try {
    return await fn();
  } finally {
    KEYS.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
};

const fakeDeps = ({ whatsappFails = false, smsFails = false } = {}) => {
  const rows = [];
  const sent = [];
  let nextId = 1;
  return {
    rows,
    sent,
    logs: {
      async create(doc) {
        if (
          doc.dedupeKey &&
          rows.some((row) => row.dedupeKey === doc.dedupeKey)
        )
          throw Object.assign(new Error("dup"), { code: 11000 });
        const row = { _id: nextId++, ...doc };
        rows.push(row);
        return row;
      },
      async findOne(query) {
        return rows.find((row) => row.dedupeKey === query.dedupeKey) || null;
      },
      async reclaimFailed(dedupeKey) {
        const row = rows.find(
          (r) => r.dedupeKey === dedupeKey && r.status === "failed",
        );
        if (!row) return null;
        row.status = "pending";
        return row;
      },
      async update(id, set) {
        Object.assign(
          rows.find((row) => row._id === id),
          set,
        );
      },
    },
    async sendWhatsApp(payload) {
      sent.push({ channel: "whatsapp", ...payload });
      if (whatsappFails)
        throw Object.assign(new Error("wa down"), {
          code: "FAST2SMS_REJECTED",
        });
      return { data: { message_id: "wa-1" } };
    },
    async sendSms(payload) {
      sent.push({ channel: "sms", ...payload });
      if (smsFails)
        throw Object.assign(new Error("sms down"), {
          code: "FAST2SMS_SMS_REJECTED",
        });
      return { data: { request_id: "sms-1" } };
    },
    log: { error() {} },
  };
};

test("pipes and newlines inside values never shift Fast2SMS variables", () => {
  assert.equal(
    joinTemplateVariables(["Ravi", "AQB12|20112026", "a\nb", undefined]),
    "Ravi|AQB12/20112026|a b|",
  );
});

test("admin phones default to 9014774667 and accept a comma list", () => {
  assert.deepEqual(getAdminAlertPhones({}), ["9014774667"]);
  assert.deepEqual(
    getAdminAlertPhones({
      ORDER_ALERT_PHONES: "+91 90147 74667, 9876543210,bad,9014774667",
    }),
    ["9014774667", "9876543210"],
  );
  assert.deepEqual(getAdminAlertPhones({ ORDER_ALERT_PHONES: "" }), []);
});

test("amounts use Indian grouping without a currency symbol", () => {
  assert.equal(formatAmount(129000), "1,29,000");
  assert.equal(formatAmount(499.5), "499.5");
});

test("events with no template configured are skipped without logging", async () =>
  withEnv(
    {
      FAST2SMS_WHATSAPP_ORDER_CONFIRMED_MESSAGE_ID: undefined,
      FAST2SMS_SMS_ORDER_CONFIRMED_MESSAGE_ID: undefined,
    },
    async () => {
      assert.equal(isPaymentTemplateConfigured("orderConfirmed"), false);
      const deps = fakeDeps();
      const result = await sendPaymentTemplate(
        {
          event: "orderConfirmed",
          to: "9876543210",
          whatsappVariables: [],
          smsVariables: [],
          dedupeKey: "k",
        },
        deps,
      );
      assert.equal(result.skipped, "NOT_CONFIGURED");
      assert.equal(deps.rows.length, 0);
      assert.equal(
        getPaymentNotificationStatus().events.orderConfirmed.whatsapp,
        false,
      );
    },
  ));

test("SMS is used only when WhatsApp fails, and the send is logged once", async () =>
  withEnv({}, async () => {
    const deps = fakeDeps({ whatsappFails: true });
    const args = {
      event: "adminOrderAlert",
      to: "9014774667",
      whatsappVariables: ["Website order", "AQOD-1"],
      smsVariables: ["Website order", "A".repeat(40)],
      dedupeKey: "order:1:admin-alert:9014774667",
      reference: "AQOD-1",
    };
    const first = await sendPaymentTemplate(args, deps);
    assert.equal(first.sent, true);
    assert.equal(first.channel, "sms");
    assert.equal(first.fallback, true);
    const sms = deps.sent.find((s) => s.channel === "sms");
    assert.equal(sms.messageId, "sms-admin");
    assert.equal(sms.variables[1].length, 30); // DLT variable limit
    assert.equal(deps.rows[0].status, "sent");

    const again = await sendPaymentTemplate(args, deps);
    assert.equal(again.duplicate, true);
    assert.equal(deps.sent.length, 2);
  }));

test("a failed send is retried by the next call", async () =>
  withEnv({}, async () => {
    const deps = fakeDeps({ whatsappFails: true, smsFails: true });
    const args = {
      event: "adminOrderAlert",
      to: "9014774667",
      whatsappVariables: [],
      smsVariables: [],
      dedupeKey: "retry-key",
    };
    const first = await sendPaymentTemplate(args, deps);
    assert.equal(first.sent, false);
    assert.equal(deps.rows[0].status, "failed");
    const retryDeps = { ...deps, sendWhatsApp: async () => ({ data: {} }) };
    const second = await sendPaymentTemplate(args, retryDeps);
    assert.equal(second.sent, true);
    assert.equal(deps.rows.length, 1);
    assert.equal(deps.rows[0].status, "sent");
  }));

test("storefront order paid: admin alert and order confirmation with link", async () =>
  withEnv({}, async () => {
    const deps = fakeDeps();
    const result = await notifyStorefrontOrderPaid(
      {
        order: {
          _id: "o1",
          orderId: "AQOD-1",
          transactionId: "AQTR-1-ABCD",
          totalAmount: 25999,
        },
        user: { firstName: "Ravi", lastName: "Kumar", phone: "9876543210" },
      },
      deps,
    );
    assert.equal(result.admin[0].sent, true);
    assert.equal(result.customer.sent, true);
    const admin = deps.sent.find((s) => s.messageId === "wa-admin");
    assert.equal(admin.to, "9014774667");
    assert.deepEqual(admin.variables, [
      "Website order",
      "AQOD-1",
      "Ravi Kumar",
      "9876543210",
      "25,999",
    ]);
    const customer = deps.sent.find((s) => s.messageId === "wa-order");
    assert.equal(customer.to, "9876543210");
    assert.deepEqual(customer.variables, [
      "Ravi Kumar",
      "AQOD-1",
      "25,999",
      "https://aquakart.co.in/order/AQTR-1-ABCD",
    ]);
  }));

test("payment link paid alerts the admin; invoice ready sends receipt with invoice link", async () =>
  withEnv({}, async () => {
    const deps = fakeDeps();
    const link = {
      _id: "l1",
      source: { kind: "pre_invoice", number: "AQPI|20261120|0001" },
      amount: 29000,
      amountPaid: 29000,
      phoneNormalized: "9876543210",
    };
    const [admin] = await notifyPaymentLinkPaid(
      { link, doc: { customerDetails: { name: "Ravi", phone: "9876543210" } } },
      deps,
    );
    assert.equal(admin.sent, true);
    assert.equal(deps.sent[0].variables[0], "Payment link");

    const invoice = {
      _id: "64b000000000000000000001",
      invoiceNo: "AQB123|20112026",
      customerDetails: { name: "Ravi", phone: 9876543210 },
    };
    const receipt = await notifyPaymentLinkInvoiceReady(
      { link, invoice },
      deps,
    );
    assert.equal(receipt.sent, true);
    const paid = deps.sent.find((s) => s.messageId === "wa-paid");
    assert.deepEqual(paid.variables, [
      "Ravi",
      "29,000",
      "AQPI|20261120|0001",
      "AQB123|20112026",
      "https://aquakart.co.in/invoice/64b000000000000000000001",
    ]);
  }));

test("receipt falls back to the invoice template when both channels fail", async () =>
  withEnv({}, async () => {
    const deps = fakeDeps({ whatsappFails: true, smsFails: true });
    let fallbackCalls = 0;
    const result = await notifyPaymentLinkInvoiceReady(
      {
        link: { _id: "l1", source: {}, amount: 1 },
        invoice: {
          _id: "64b000000000000000000002",
          customerDetails: { phone: "9876543210" },
        },
        fallback: async () => {
          fallbackCalls += 1;
        },
      },
      deps,
    );
    assert.equal(fallbackCalls, 1);
    assert.equal(result.fallback, "invoice-template");
  }));

test("payment link request: WhatsApp with link and India-time expiry, no SMS", async () =>
  withEnv({}, async () => {
    const deps = fakeDeps({ whatsappFails: true });
    const link = {
      _id: "l9",
      source: { number: "AQPI|20261120|0001" },
      amount: 29000,
      phoneNormalized: "9876543210",
      expiresAt: "2026-11-23T05:00:00.000Z",
    };
    const url = "https://aquakart.co.in/pay/abc";
    const failed = await notifyPaymentLinkCreated(
      { link, doc: { customerDetails: { name: "Ravi" } }, url },
      deps,
    );
    assert.equal(failed.sent, false);
    assert.ok(deps.sent.every((s) => s.channel === "whatsapp"));
    const [message] = deps.sent;
    assert.equal(message.messageId, "wa-link");
    assert.deepEqual(message.variables.slice(0, 4), [
      "Ravi",
      "AQPI|20261120|0001",
      "29,000",
      url,
    ]);
    assert.match(message.variables[4], /23 Nov 2026/);
    assert.match(message.variables[4], /10:30/);
    assert.equal(
      getPaymentNotificationStatus().events.paymentLinkRequest.sms,
      false,
    );
  }));
