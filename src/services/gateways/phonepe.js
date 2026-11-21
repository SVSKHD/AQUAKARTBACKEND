import crypto from "crypto";
import axios from "axios";

// PhonePe payment gateway, shared by storefront checkout (/v1/payments), the
// legacy /checkout page (/v1/order/pay) and CRM payment links
// (/v1/payments/offline). See docs/PHONEPE_GATEWAY.md.
//
// Two API versions behind one interface:
//   v1 (default)  /pg/v1/pay + salt-key X-VERIFY checksum. Deprecated by
//                 PhonePe.
//   v2            Standard Checkout: OAuth token (client id/secret/version),
//                 POST /checkout/v2/pay, GET /checkout/v2/order/{id}/status,
//                 one dashboard-configured webhook.
// PHONEPE_API_VERSION=v2 switches every caller at once; unset or "v1" keeps v1.
//
// createPhonePePayment → { redirectUrl, transactionId, raw }
// verifyPhonePePayment → { status: paid|pending|failed, amount (rupees), code,
//   errorCode, merchantId, merchantTransactionId, gatewayTransactionId,
//   paymentInstrumentType, instrument, raw }

const REQUEST_TIMEOUT_MS = 20_000;
// Renew the v2 token this long before PhonePe says it expires.
const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;
// When PhonePe sends no expiry, keep a token this long at most.
const TOKEN_FALLBACK_TTL_MS = 30 * 60 * 1000;

const env = () => process.env;

export const phonePeApiVersion = (vars = env()) =>
  String(vars.PHONEPE_API_VERSION || "v1")
    .trim()
    .toLowerCase() === "v2"
    ? "v2"
    : "v1";

// ---- v1 configuration -------------------------------------------------------
const merchantId = () => env().PHONEPE_MERCHANTID;
const saltKey = () => env().PHONEPE_KEY;
const keyIndex = () => env().PHONEPE_KEY_INDEX || "1";
const v1BaseUrl = () =>
  env().PHONEPE_BASE_URL || "https://api.phonepe.com/apis/hermes";

// ---- v2 configuration -------------------------------------------------------
export const phonePeV2Config = (vars = env()) => {
  const sandbox = String(vars.PHONEPE_ENV || "").toLowerCase() === "sandbox";
  return {
    clientId: vars.PHONEPE_CLIENT_ID || "",
    clientSecret: vars.PHONEPE_CLIENT_SECRET || "",
    clientVersion: vars.PHONEPE_CLIENT_VERSION || "",
    authUrl:
      vars.PHONEPE_AUTH_URL ||
      (sandbox
        ? "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token"
        : "https://api.phonepe.com/apis/identity-manager/v1/oauth/token"),
    baseUrl: (
      vars.PHONEPE_V2_BASE_URL ||
      (sandbox
        ? "https://api-preprod.phonepe.com/apis/pg-sandbox"
        : "https://api.phonepe.com/apis/pg")
    ).replace(/\/+$/, ""),
  };
};

export const phonePeMerchantId = () => merchantId() || "";

// Everything the active version needs. PHONEPE_MERCHANTID is required for v2
// too: payment links check it against every verified payment.
export const isPhonePeConfigured = (vars = env()) => {
  if (phonePeApiVersion(vars) === "v1")
    return Boolean(vars.PHONEPE_MERCHANTID && vars.PHONEPE_KEY);
  const c = phonePeV2Config(vars);
  return Boolean(
    vars.PHONEPE_MERCHANTID && c.clientId && c.clientSecret && c.clientVersion,
  );
};

const notConfigured = () =>
  Object.assign(new Error("PhonePe is not configured"), { status: 503 });

const gatewayError = (message, code, cause) =>
  Object.assign(new Error(message), {
    status: 502,
    code: code || "PHONEPE_ERROR",
    cause,
  });

const ecomBase = () => env().ECOM_BASE_URL || "https://aquakart.co.in";
const apiBase = () => env().API_BASE_URL || "https://api.aquakart.co.in";

// ============================== v1 ==========================================

const v1Create = async ({
  transactionId,
  userId,
  amount,
  phone,
  redirectUrl,
  callbackUrl,
}) => {
  if (!merchantId() || !saltKey()) throw notConfigured();
  const payload = {
    merchantId: merchantId(),
    merchantTransactionId: transactionId,
    merchantUserId: String(userId),
    amount: Math.round(amount * 100),
    redirectUrl: redirectUrl || `${ecomBase()}/order/${transactionId}`,
    redirectMode: "REDIRECT",
    callbackUrl:
      callbackUrl ||
      `${apiBase()}/v1/webhooks/payments/phonepe/${transactionId}`,
    mobileNumber: String(phone || "")
      .replace(/\D/g, "")
      .slice(-10),
    paymentInstrument: { type: "PAY_PAGE" },
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const path = "/pg/v1/pay";
  const checksum = `${crypto.createHash("sha256").update(`${encoded}${path}${saltKey()}`).digest("hex")}###${keyIndex()}`;
  const response = await axios.post(
    `${v1BaseUrl()}${path}`,
    { request: encoded },
    {
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  return {
    redirectUrl: response.data?.data?.instrumentResponse?.redirectInfo?.url,
    transactionId: response.data?.data?.merchantTransactionId,
    raw: response.data,
  };
};

const v1Verify = async (transactionId) => {
  if (!merchantId() || !saltKey()) throw notConfigured();
  const path = `/pg/v1/status/${merchantId()}/${transactionId}`;
  const checksum = `${crypto.createHash("sha256").update(`${path}${saltKey()}`).digest("hex")}###${keyIndex()}`;
  const response = await axios.get(`${v1BaseUrl()}${path}`, {
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      "X-VERIFY": checksum,
      "X-MERCHANT-ID": merchantId(),
    },
    timeout: REQUEST_TIMEOUT_MS,
  });
  const code = response.data?.code;
  const status =
    code === "PAYMENT_SUCCESS"
      ? "paid"
      : code === "PAYMENT_PENDING"
        ? "pending"
        : "failed";
  const data = response.data?.data || {};
  return {
    status,
    amount: Number(data.amount || 0) / 100,
    code: code || null,
    errorCode: status === "failed" ? code || null : null,
    merchantId: data.merchantId || null,
    merchantTransactionId: data.merchantTransactionId || null,
    gatewayTransactionId: data.transactionId || null,
    paymentInstrumentType: data.paymentInstrument?.type || null,
    instrument: data.paymentInstrument || null,
    raw: response.data,
  };
};

// ============================== v2 ==========================================

let tokenCache = null; // { token, type, expiresAt (ms) }
let tokenRequest = null;

export const resetPhonePeTokenCache = () => {
  tokenCache = null;
  tokenRequest = null;
};

const fetchV2Token = async () => {
  const c = phonePeV2Config();
  const form = new URLSearchParams({
    client_id: c.clientId,
    client_version: c.clientVersion,
    client_secret: c.clientSecret,
    grant_type: "client_credentials",
  });
  let response;
  try {
    response = await axios.post(c.authUrl, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    // Never log or return the credentials; PhonePe's message is enough.
    throw gatewayError(
      "PhonePe sign-in failed. Check PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET and PHONEPE_CLIENT_VERSION.",
      "PHONEPE_AUTH_FAILED",
      error?.response?.data?.code || error?.code,
    );
  }
  const data = response.data || {};
  if (!data.access_token)
    throw gatewayError(
      "PhonePe sign-in returned no access token",
      "PHONEPE_AUTH_FAILED",
    );
  const expiresAtMs = Number(data.expires_at) * 1000;
  return {
    token: data.access_token,
    type: data.token_type || "O-Bearer",
    expiresAt:
      Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
        ? expiresAtMs
        : Date.now() + TOKEN_FALLBACK_TTL_MS,
  };
};

// One token for the whole process, renewed shortly before it expires;
// concurrent callers share one request.
const v2Token = async () => {
  if (tokenCache && tokenCache.expiresAt - TOKEN_RENEW_MARGIN_MS > Date.now())
    return tokenCache;
  if (!tokenRequest)
    tokenRequest = fetchV2Token()
      .then((token) => {
        tokenCache = token;
        return token;
      })
      .finally(() => {
        tokenRequest = null;
      });
  return tokenRequest;
};

// An authorised v2 call. A 401 means the token went stale early: drop it and
// retry once with a new one.
const v2Request = async (send) => {
  const run = async () => {
    const { token, type } = await v2Token();
    return send({ Authorization: `${type} ${token}` });
  };
  try {
    return await run();
  } catch (error) {
    if (error?.response?.status !== 401) throw error;
    tokenCache = null;
    return run();
  }
};

const v2Create = async ({
  transactionId,
  userId,
  amount,
  redirectUrl,
  expireAfterSeconds,
}) => {
  if (!isPhonePeConfigured()) throw notConfigured();
  const { baseUrl } = phonePeV2Config();
  const body = {
    merchantOrderId: transactionId,
    amount: Math.round(amount * 100),
    // Returned unchanged in status and webhook payloads.
    metaInfo: { udf1: String(userId || "").slice(0, 256) },
    paymentFlow: {
      type: "PG_CHECKOUT",
      merchantUrls: {
        redirectUrl: redirectUrl || `${ecomBase()}/order/${transactionId}`,
      },
    },
  };
  if (expireAfterSeconds)
    body.expireAfter = Math.min(
      3600,
      Math.max(300, Math.round(expireAfterSeconds)),
    );
  let response;
  try {
    response = await v2Request((auth) =>
      axios.post(`${baseUrl}/checkout/v2/pay`, body, {
        headers: { "Content-Type": "application/json", ...auth },
        timeout: REQUEST_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    if (error?.code === "PHONEPE_AUTH_FAILED") throw error;
    const data = error?.response?.data;
    throw gatewayError(
      data?.message || "PhonePe could not start the payment",
      data?.code,
    );
  }
  const data = response.data || {};
  return {
    redirectUrl: data.redirectUrl,
    transactionId: data.orderId || null,
    raw: data,
  };
};

const V2_STATUS = { COMPLETED: "paid", PENDING: "pending", FAILED: "failed" };

// The attempt to report: the completed one if any, else the newest.
const latestAttempt = (details = []) => {
  const list = Array.isArray(details) ? details : [];
  return (
    list.find((d) => d?.state === "COMPLETED") ||
    [...list].sort((a, b) => Number(b?.timestamp) - Number(a?.timestamp))[0] ||
    null
  );
};

export const normalizeV2Status = (data = {}, queriedId = null) => {
  const attempt = latestAttempt(data.paymentDetails);
  const status = V2_STATUS[data.state] || "pending";
  return {
    status,
    amount: Number(data.amount || 0) / 100,
    code: data.state || null,
    errorCode:
      status === "failed"
        ? data.errorCode || attempt?.errorCode || data.state || null
        : null,
    // The status call is authenticated with our own token, so the order is
    // ours; fall back to our ids when PhonePe omits them.
    merchantId: data.merchantId || phonePeMerchantId() || null,
    merchantTransactionId: data.merchantOrderId || queriedId,
    gatewayTransactionId: attempt?.transactionId || data.orderId || null,
    paymentInstrumentType: attempt?.paymentMode || null,
    instrument: attempt,
    raw: data,
  };
};

const v2Verify = async (transactionId) => {
  if (!isPhonePeConfigured()) throw notConfigured();
  const { baseUrl } = phonePeV2Config();
  try {
    const response = await v2Request((auth) =>
      axios.get(
        `${baseUrl}/checkout/v2/order/${encodeURIComponent(transactionId)}/status`,
        {
          params: { details: false, errorContext: true },
          headers: { "Content-Type": "application/json", ...auth },
          timeout: REQUEST_TIMEOUT_MS,
        },
      ),
    );
    return normalizeV2Status(response.data, transactionId);
  } catch (error) {
    // PhonePe never created this order (the pay call failed): nothing to pay.
    if (error?.response?.data?.code === "INVALID_MERCHANT_ORDER_ID")
      return normalizeV2Status(
        { state: "FAILED", errorCode: "INVALID_MERCHANT_ORDER_ID" },
        transactionId,
      );
    throw error;
  }
};

// ---- v2 webhook ------------------------------------------------------------

// PhonePe's "SHA" webhook auth: Authorization carries SHA256(username:password)
// for the username/password set on the dashboard webhook. Accepts the hash
// with or without a "SHA256 " prefix, in any letter case.
export const isPhonePeWebhookAuthorized = (header, vars = env()) => {
  const username = vars.PHONEPE_WEBHOOK_USERNAME || "";
  const password = vars.PHONEPE_WEBHOOK_PASSWORD || "";
  if (!username || !password) return null; // not set up: caller decides
  const expected = crypto
    .createHash("sha256")
    .update(`${username}:${password}`)
    .digest("hex");
  const given = String(header || "")
    .trim()
    .replace(/^sha256\s+/i, "")
    .toLowerCase();
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};

// ============================== public ======================================

// redirectUrl / callbackUrl are optional: checkout keeps /order/{id}; payment
// links pass their own page. callbackUrl only exists in v1 (v2 uses the
// dashboard webhook). expireAfterSeconds only applies to v2 (300-3600).
export const createPhonePePayment = (args) =>
  phonePeApiVersion() === "v2" ? v2Create(args) : v1Create(args);

export const verifyPhonePePayment = (transactionId) =>
  phonePeApiVersion() === "v2"
    ? v2Verify(transactionId)
    : v1Verify(transactionId);
