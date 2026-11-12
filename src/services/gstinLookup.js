/**
 * GSTIN lookup through GSTIN API (https://www.gstinapi.in), which reads the
 * taxpayer record from the GST network.
 *
 * Contract (https://gstinapi.in/openapi.json):
 *  - GET {base}/v1/gstin/{gstin}   header x-api-key: <key>
 *  - 200 { success: true, gstin, data: GstinRecord, credits_remaining, ... }
 *  - errors { success: false, error } with 400 (bad format, not charged),
 *    401 (missing/invalid key), 402 (no credits), 403 (account deactivated),
 *    404 (not registered), 429 (rate limit, 60/min), 502 (upstream down)
 *  - sandbox GSTIN 00AAAAA0000A1ZT: fixed sample, no credit used
 *
 * The key comes only from the environment and is never logged or returned.
 * Real lookups use credits, so results are cached in memory.
 */

const API_KEY_ENV = "GST_ENABLE_KEY";
const DEFAULT_BASE_URL = "https://www.gstinapi.in";
const DEFAULT_TIMEOUT_MS = 15000;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 500;
const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// The provider's free test GSTIN (its check digit is not a real one).
export const SANDBOX_GSTIN = "00AAAAA0000A1ZT";

export class GstinLookupError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = "GstinLookupError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const normalizeGstin = (value) =>
  String(value ?? "")
    .replace(/\s/g, "")
    .toUpperCase();

export const gstinCheckDigit = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARSET.indexOf(first14[i]);
    if (value < 0) return "";
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
};

export const isValidGstin = (value) => {
  const gstin = normalizeGstin(value);
  return (
    GSTIN_SHAPE.test(gstin) && gstinCheckDigit(gstin.slice(0, 14)) === gstin[14]
  );
};

export const getGstinLookupStatus = (env = process.env) => {
  const missing = [API_KEY_ENV].filter((key) => !String(env[key] || "").trim());
  return { available: missing.length === 0, provider: "gstinapi", missing };
};

const clean = (value) => String(value ?? "").trim();

/** Structured address parts joined in postal order, skipping blanks/dupes. */
export const formatGstAddress = (addr = {}) => {
  const parts = [
    addr.floor,
    addr.building_number,
    addr.building_name,
    addr.street,
    addr.locality,
    addr.city,
    addr.district,
    addr.state,
  ]
    .map(clean)
    .filter(Boolean)
    .filter(
      (part, index, all) =>
        all.findIndex((p) => p.toLowerCase() === part.toLowerCase()) === index,
    );
  const pincode = clean(addr.pincode);
  const line = parts.join(", ");
  if (!pincode) return line;
  return line ? `${line} - ${pincode}` : pincode;
};

/** Provider record -> the small shape the CRM uses (unchanged field names). */
export const toTaxpayer = (data = {}, fetchedAt = new Date()) => {
  const details = data.address_details || {};
  const pincode = clean(data.pincode || details.pincode);
  // Prefer the structured parts (they include the state); fall back to the
  // provider's one-line address.
  const structured = formatGstAddress({ ...details, pincode });
  const oneLine = clean(data.address);
  const address =
    structured && structured !== pincode
      ? structured
      : oneLine && pincode && !oneLine.includes(pincode)
        ? `${oneLine} - ${pincode}`
        : oneLine || pincode;
  return {
    gstin: normalizeGstin(data.gstin),
    legalName: clean(data.legal_name),
    tradeName: clean(data.trade_name),
    status: clean(data.status),
    constitution: clean(data.business_constitution),
    taxpayerType: clean(data.taxpayer_type),
    registeredOn: clean(data.registration_date),
    cancelledOn: clean(data.cancellation_date),
    address,
    state: clean(details.state),
    stateCode: clean(data.state_code),
    pincode,
    source: "gstinapi",
    fetchedAt: fetchedAt.toISOString(),
  };
};

const providerMessage = (body) =>
  body && typeof body === "object"
    ? clean([body.error, body.message].find((v) => typeof v === "string"))
    : "";

// Provider HTTP status -> our error (the CRM sees code + statusCode).
const providerError = (status, message) => {
  const detail = message ? `: ${message.slice(0, 200)}` : "";
  if (status === 400)
    return new GstinLookupError(
      "Enter a valid 15-character GSTIN.",
      "GSTIN_INVALID",
      400,
    );
  if (status === 404)
    return new GstinLookupError(
      "No taxpayer is registered with this GSTIN on the GST portal.",
      "GSTIN_NOT_FOUND",
      404,
    );
  if (status === 401 || status === 403)
    return new GstinLookupError(
      "The GST lookup service rejected our API key. Check GST_ENABLE_KEY on the server.",
      "GSTIN_PROVIDER_AUTH",
      502,
    );
  if (status === 402)
    return new GstinLookupError(
      "The GST lookup account has no credits left. Top up at gstinapi.in.",
      "GSTIN_PROVIDER_NO_CREDITS",
      502,
    );
  if (status === 429)
    return new GstinLookupError(
      "Too many GST lookups right now. Try again in a minute.",
      "GSTIN_PROVIDER_RATE_LIMITED",
      429,
    );
  return new GstinLookupError(
    `The GST lookup service couldn't answer${detail}. Try again.`,
    "GSTIN_PROVIDER_ERROR",
    502,
  );
};

export const createGstinLookup = ({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) => {
  const cache = new Map(); // gstin -> { expiresAt, value | error }

  const baseUrl = () =>
    clean(env.GSTINAPI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = () => {
    const parsed = Number(env.GSTIN_LOOKUP_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  };

  const remember = (gstin, entry) => {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(gstin, entry);
  };

  const fetchRecord = async (gstin) => {
    let response;
    try {
      response = await fetchImpl(
        `${baseUrl()}/v1/gstin/${encodeURIComponent(gstin)}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "x-api-key": clean(env[API_KEY_ENV]),
          },
          signal: AbortSignal.timeout(timeoutMs()),
        },
      );
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError")
        throw new GstinLookupError(
          "The GST lookup service took too long to answer. Try again.",
          "GSTIN_PROVIDER_TIMEOUT",
          504,
        );
      throw new GstinLookupError(
        "Couldn't reach the GST lookup service. Try again.",
        "GSTIN_PROVIDER_UNREACHABLE",
        502,
      );
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  };

  const lookup = async (input) => {
    const gstin = normalizeGstin(input);
    if (gstin !== SANDBOX_GSTIN && !isValidGstin(gstin))
      throw new GstinLookupError(
        "Enter a valid 15-character GSTIN.",
        "GSTIN_INVALID",
        400,
      );
    if (!getGstinLookupStatus(env).available)
      throw new GstinLookupError(
        "GST portal lookup isn't set up on the server yet.",
        "GSTIN_LOOKUP_DISABLED",
        503,
      );

    const cached = cache.get(gstin);
    if (cached && cached.expiresAt > now()) {
      if (cached.error) throw cached.error;
      return { ...cached.value, cached: true };
    }

    const { response, body } = await fetchRecord(gstin);
    const data =
      response.ok && body?.success !== false && body?.data ? body.data : null;
    if (!data || !clean(data.gstin || data.legal_name)) {
      const error = providerError(
        response.ok ? 502 : response.status,
        providerMessage(body),
      );
      if (error.code === "GSTIN_NOT_FOUND")
        remember(gstin, { error, expiresAt: now() + NOT_FOUND_TTL_MS });
      throw error;
    }

    const value = {
      ...toTaxpayer({ gstin, ...data }, new Date(now())),
      creditsRemaining: Number.isFinite(body.credits_remaining)
        ? body.credits_remaining
        : null,
      ...(body.test === true || data.test === true ? { test: true } : {}),
    };
    remember(gstin, { value, expiresAt: now() + RESULT_TTL_MS });
    return { ...value, cached: false };
  };

  return { lookup, getStatus: () => getGstinLookupStatus(env) };
};

const defaultLookup = createGstinLookup();
export const lookupGstin = (gstin) => defaultLookup.lookup(gstin);
