import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import axios from "axios";
import {
  createPhonePePayment,
  isPhonePeConfigured,
  isPhonePeWebhookAuthorized,
  normalizeV2Status,
  phonePeApiVersion,
  resetPhonePeTokenCache,
  verifyPhonePePayment,
} from "../src/services/gateways/phonepe.js";
import { phonePeWebhookV2 } from "../src/controllers/payments.js";
import PaymentAttempt from "../src/models/paymentAttempt.js";
import Order from "../src/models/orders.js";
import { paymentModes } from "../src/services/offlinePayments/rules.js";

// PhonePe gateway v1/v2 switch. axios is mocked: no network, no payments.

const KEYS = [
  "PHONEPE_API_VERSION",
  "PHONEPE_ENV",
  "PHONEPE_MERCHANTID",
  "PHONEPE_KEY",
  "PHONEPE_CLIENT_ID",
  "PHONEPE_CLIENT_SECRET",
  "PHONEPE_CLIENT_VERSION",
  "PHONEPE_WEBHOOK_USERNAME",
  "PHONEPE_WEBHOOK_PASSWORD",
];

const withEnv = (t, vars) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  resetPhonePeTokenCache();
  t.after(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetPhonePeTokenCache();
  });
};

const V2 = {
  PHONEPE_API_VERSION: "v2",
  PHONEPE_MERCHANTID: "M123",
  PHONEPE_CLIENT_ID: "client-id",
  PHONEPE_CLIENT_SECRET: "client-secret",
  PHONEPE_CLIENT_VERSION: "1",
};

const tokenResponse = (token = "tok-1", lifetimeSec = 3600) => ({
  data: {
    access_token: token,
    token_type: "O-Bearer",
    expires_at: Math.floor(Date.now() / 1000) + lifetimeSec,
  },
});

test("v1 stays the default; v2 only when asked", (t) => {
  withEnv(t, {});
  assert.equal(phonePeApiVersion(), "v1");
  assert.equal(phonePeApiVersion({ PHONEPE_API_VERSION: " V2 " }), "v2");
  assert.equal(phonePeApiVersion({ PHONEPE_API_VERSION: "v3" }), "v1");
});

test("configured means the active version's credentials are all set", () => {
  assert.equal(
    isPhonePeConfigured({ PHONEPE_MERCHANTID: "M", PHONEPE_KEY: "k" }),
    true,
  );
  assert.equal(isPhonePeConfigured({ PHONEPE_MERCHANTID: "M" }), false);
  assert.equal(isPhonePeConfigured(V2), true);
  assert.equal(
    isPhonePeConfigured({ ...V2, PHONEPE_CLIENT_SECRET: "" }),
    false,
  );
  // Salt-key settings don't count for v2.
  assert.equal(
    isPhonePeConfigured({
      PHONEPE_API_VERSION: "v2",
      PHONEPE_MERCHANTID: "M",
      PHONEPE_KEY: "k",
    }),
    false,
  );
});

test("v2 create: token by form post, then /checkout/v2/pay with O-Bearer", async (t) => {
  withEnv(t, V2);
  const calls = [];
  t.mock.method(axios, "post", async (url, body, config) => {
    calls.push({ url, body, headers: config.headers });
    if (url.endsWith("/v1/oauth/token")) return tokenResponse();
    return {
      data: {
        orderId: "OMO1",
        state: "PENDING",
        redirectUrl: "https://mercury.phonepe.com/transact/x",
      },
    };
  });
  const result = await createPhonePePayment({
    transactionId: "AQPL123",
    userId: "u1",
    amount: 249.5,
    redirectUrl: "https://aquakart.co.in/pay/t?return=1",
    expireAfterSeconds: 900,
  });
  assert.deepEqual(
    { redirectUrl: result.redirectUrl, transactionId: result.transactionId },
    {
      redirectUrl: "https://mercury.phonepe.com/transact/x",
      transactionId: "OMO1",
    },
  );
  const [auth, pay] = calls;
  assert.equal(
    auth.url,
    "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
  );
  assert.equal(
    auth.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const form = new URLSearchParams(auth.body);
  assert.equal(form.get("client_id"), "client-id");
  assert.equal(form.get("client_secret"), "client-secret");
  assert.equal(form.get("client_version"), "1");
  assert.equal(form.get("grant_type"), "client_credentials");

  assert.equal(pay.url, "https://api.phonepe.com/apis/pg/checkout/v2/pay");
  assert.equal(pay.headers.Authorization, "O-Bearer tok-1");
  assert.deepEqual(pay.body, {
    merchantOrderId: "AQPL123",
    amount: 24950,
    metaInfo: { udf1: "u1" },
    paymentFlow: {
      type: "PG_CHECKOUT",
      merchantUrls: { redirectUrl: "https://aquakart.co.in/pay/t?return=1" },
    },
    expireAfter: 900,
  });
});

test("v2 sandbox hosts; the token is reused until close to expiry", async (t) => {
  withEnv(t, { ...V2, PHONEPE_ENV: "sandbox" });
  const urls = [];
  t.mock.method(axios, "post", async (url) => {
    urls.push(url);
    if (url.includes("oauth")) return tokenResponse("tok-s", 3600);
    return { data: { orderId: "O", redirectUrl: "https://x" } };
  });
  await createPhonePePayment({ transactionId: "A1", userId: "u", amount: 1 });
  await createPhonePePayment({ transactionId: "A2", userId: "u", amount: 1 });
  assert.deepEqual(urls, [
    "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
    "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay",
    "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay",
  ]);
});

test("v2: a token about to expire is renewed; a 401 retries once with a new one", async (t) => {
  withEnv(t, V2);
  let tokens = 0;
  const used = [];
  t.mock.method(axios, "post", async (url, _body, config) => {
    if (url.includes("oauth")) {
      tokens += 1;
      // tok-1 expires in 2 minutes: inside the 5-minute renewal margin.
      return tokenResponse(`tok-${tokens}`, tokens === 1 ? 120 : 3600);
    }
    used.push(config.headers.Authorization);
    if (config.headers.Authorization === "O-Bearer tok-2") {
      const error = new Error("unauthorized");
      error.response = { status: 401, data: {} };
      throw error;
    }
    return { data: { orderId: "O", redirectUrl: "https://x" } };
  });
  await createPhonePePayment({ transactionId: "A1", userId: "u", amount: 1 });
  await createPhonePePayment({ transactionId: "A2", userId: "u", amount: 1 });
  // Second payment: tok-1 is near expiry → tok-2, refused (401) → tok-3.
  assert.deepEqual(used, [
    "O-Bearer tok-1",
    "O-Bearer tok-2",
    "O-Bearer tok-3",
  ]);
  assert.equal(tokens, 3);
});

test("v2 sign-in failure never exposes the secret", async (t) => {
  withEnv(t, V2);
  t.mock.method(axios, "post", async () => {
    const error = new Error("bad credentials client-secret");
    error.response = { status: 400, data: { code: "BAD_REQUEST" } };
    throw error;
  });
  await assert.rejects(
    createPhonePePayment({ transactionId: "A1", userId: "u", amount: 1 }),
    (error) => {
      assert.equal(error.code, "PHONEPE_AUTH_FAILED");
      assert.ok(!error.message.includes("client-secret"));
      return true;
    },
  );
});

test("v2 verify: COMPLETED with the attempt's mode and transaction id", async (t) => {
  withEnv(t, V2);
  const gets = [];
  t.mock.method(axios, "post", async () => tokenResponse());
  t.mock.method(axios, "get", async (url, config) => {
    gets.push({ url, config });
    return {
      data: {
        orderId: "OMO1",
        merchantId: "M123",
        merchantOrderId: "AQPL123",
        state: "COMPLETED",
        amount: 24950,
        paymentDetails: [
          {
            paymentMode: "UPI_INTENT",
            transactionId: "T-1",
            timestamp: 1,
            amount: 24950,
            state: "FAILED",
            errorCode: "INVALID_MPIN",
          },
          {
            paymentMode: "CARD",
            transactionId: "T-2",
            timestamp: 2,
            amount: 24950,
            state: "COMPLETED",
          },
        ],
      },
    };
  });
  const v = await verifyPhonePePayment("AQPL123");
  assert.equal(
    gets[0].url,
    "https://api.phonepe.com/apis/pg/checkout/v2/order/AQPL123/status",
  );
  assert.equal(gets[0].config.headers.Authorization, "O-Bearer tok-1");
  assert.equal(v.status, "paid");
  assert.equal(v.amount, 249.5);
  assert.equal(v.merchantId, "M123");
  assert.equal(v.merchantTransactionId, "AQPL123");
  assert.equal(v.gatewayTransactionId, "T-2");
  assert.equal(v.paymentInstrumentType, "CARD");
  assert.deepEqual(paymentModes(v.paymentInstrumentType), {
    invoice: "card",
    document: "Card",
  });
});

test("v2 verify: failed and never-created orders are failed with a reason", async (t) => {
  withEnv(t, V2);
  t.mock.method(axios, "post", async () => tokenResponse());
  let reply;
  t.mock.method(axios, "get", async () => {
    if (reply instanceof Error) throw reply;
    return { data: reply };
  });
  reply = {
    state: "FAILED",
    amount: 100,
    errorCode: "INVALID_MPIN",
    paymentDetails: [],
  };
  const failed = await verifyPhonePePayment("A1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "INVALID_MPIN");

  reply = Object.assign(new Error("not found"), {
    response: {
      status: 400,
      data: { code: "INVALID_MERCHANT_ORDER_ID" },
    },
  });
  const missing = await verifyPhonePePayment("A2");
  assert.equal(missing.status, "failed");
  assert.equal(missing.errorCode, "INVALID_MERCHANT_ORDER_ID");
  assert.equal(missing.merchantTransactionId, "A2");
});

test("v2 status mapping: pending until PhonePe says otherwise", () => {
  assert.equal(normalizeV2Status({ state: "PENDING" }).status, "pending");
  assert.equal(normalizeV2Status({ state: "SOMETHING_NEW" }).status, "pending");
  assert.deepEqual(paymentModes("NET_BANKING"), {
    invoice: "bank_transfer",
    document: "Bank Transfer",
  });
});

test("v1 is unchanged: salt-key checksum to /pg/v1/pay", async (t) => {
  withEnv(t, { PHONEPE_MERCHANTID: "M1", PHONEPE_KEY: "salt" });
  let sent;
  t.mock.method(axios, "post", async (url, body, config) => {
    sent = { url, body, config };
    return {
      data: {
        data: {
          merchantTransactionId: "A1",
          instrumentResponse: { redirectInfo: { url: "https://pay" } },
        },
      },
    };
  });
  const result = await createPhonePePayment({
    transactionId: "A1",
    userId: "u",
    amount: 10,
  });
  assert.equal(result.redirectUrl, "https://pay");
  assert.equal(sent.url, "https://api.phonepe.com/apis/hermes/pg/v1/pay");
  const expected = `${crypto
    .createHash("sha256")
    .update(`${sent.body.request}/pg/v1/paysalt`)
    .digest("hex")}###1`;
  assert.equal(sent.config.headers["X-VERIFY"], expected);
});

test("webhook auth: SHA256(username:password), with or without a prefix", (t) => {
  const vars = {
    PHONEPE_WEBHOOK_USERNAME: "aquakart",
    PHONEPE_WEBHOOK_PASSWORD: "s3cret",
  };
  const hash = crypto
    .createHash("sha256")
    .update("aquakart:s3cret")
    .digest("hex");
  assert.equal(isPhonePeWebhookAuthorized(hash, vars), true);
  assert.equal(isPhonePeWebhookAuthorized(hash.toUpperCase(), vars), true);
  assert.equal(isPhonePeWebhookAuthorized(`SHA256 ${hash}`, vars), true);
  assert.equal(isPhonePeWebhookAuthorized("nope", vars), false);
  assert.equal(isPhonePeWebhookAuthorized(undefined, vars), false);
  assert.equal(isPhonePeWebhookAuthorized(hash, {}), null);
});

const recorder = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};
const webhookReq = (merchantOrderId, authorization) => ({
  get: (name) =>
    name.toLowerCase() === "authorization" ? authorization : undefined,
  body: {
    event: "checkout.order.completed",
    payload: { merchantOrderId, state: "COMPLETED" },
  },
});

test("v2 webhook: refuses a wrong Authorization and a missing order id", async (t) => {
  withEnv(t, {
    ...V2,
    PHONEPE_WEBHOOK_USERNAME: "u",
    PHONEPE_WEBHOOK_PASSWORD: "p",
  });
  const bad = recorder();
  await phonePeWebhookV2(webhookReq("AQPL1", "wrong"), bad);
  assert.equal(bad.statusCode, 401);

  const good = crypto.createHash("sha256").update("u:p").digest("hex");
  const missing = recorder();
  await phonePeWebhookV2(webhookReq("", good), missing);
  assert.equal(missing.statusCode, 400);
});

test("v2 webhook: unknown orders are acknowledged; the body is never trusted", async (t) => {
  withEnv(t, V2);
  t.mock.method(PaymentAttempt, "findOne", async () => null);
  t.mock.method(Order, "exists", async () => null);
  const verify = t.mock.method(axios, "get", async () => {
    throw new Error("must not ask PhonePe for an unknown order");
  });
  const res = recorder();
  await phonePeWebhookV2(webhookReq("AQPL-UNKNOWN"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(verify.mock.callCount(), 0);
});

test("v2 webhook: a known attempt is settled from the status API", async (t) => {
  withEnv(t, V2);
  t.mock.method(axios, "post", async () => tokenResponse());
  const statusCalls = t.mock.method(axios, "get", async () => ({
    data: { state: "PENDING", amount: 100, merchantOrderId: "AQ1" },
  }));
  const attempt = {
    merchantTransactionId: "AQ1",
    source: "ECOM",
    status: "pending",
    amount: 1,
    statusHistory: [],
    save: async () => attempt,
  };
  t.mock.method(PaymentAttempt, "findOne", async () => attempt);
  t.mock.method(Order, "findById", async () => null);
  t.mock.method(Order, "updateOne", async () => ({}));
  const res = recorder();
  await phonePeWebhookV2(webhookReq("AQ1"), res);
  assert.equal(statusCalls.mock.callCount(), 1);
  assert.equal(attempt.status, "pending");
  assert.equal(res.statusCode, 200);
});
