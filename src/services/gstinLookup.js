/**
 * GSTIN lookup through Masters India (a licensed GST Suvidha Provider), which
 * reads the taxpayer record from the government GST system.
 *
 * Contract (docs.mastersindia.co/gst-verification-api):
 *  - POST {base}/oauth/access_token  JSON {username, password, client_id,
 *    client_secret, grant_type: "password"} -> {access_token, expires_in}
 *  - GET  {base}/commonapis/searchgstin?gstin=...  headers
 *    Authorization: Bearer <token>, client_id -> {error: false, data: {...}}
 *
 * Credentials come only from environment variables and are never logged or
 * returned. Lookups are paid per call, so results are cached in memory.
 */

const ENV_KEYS = {
  username: "MASTERS_INDIA_USERNAME",
  password: "MASTERS_INDIA_PASSWORD",
  clientId: "MASTERS_INDIA_CLIENT_ID",
  clientSecret: "MASTERS_INDIA_CLIENT_SECRET",
};
const DEFAULT_BASE_URL = "https://commonapi.mastersindia.co";
const DEFAULT_TIMEOUT_MS = 15000;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 500;
const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

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
  const missing = Object.values(ENV_KEYS).filter(
    (key) => !String(env[key] || "").trim(),
  );
  return { available: missing.length === 0, provider: "mastersindia", missing };
};

const clean = (value) => String(value ?? "").trim();

/** Principal address parts joined in postal order, skipping blanks/dupes. */
export const formatGstAddress = (addr = {}) => {
  const parts = [
    addr.flno,
    addr.bno,
    addr.bnm,
    addr.st,
    addr.loc,
    addr.city,
    addr.dst,
    addr.stcd,
  ]
    .map(clean)
    .filter(Boolean)
    .filter(
      (part, index, all) =>
        all.findIndex((p) => p.toLowerCase() === part.toLowerCase()) === index,
    );
  const pincode = clean(addr.pncd);
  const line = parts.join(", ");
  if (!pincode) return line;
  return line ? `${line} - ${pincode}` : pincode;
};

/** Provider payload -> the small shape the CRM uses. */
export const toTaxpayer = (data = {}, fetchedAt = new Date()) => {
  const addr = data?.pradr?.addr || {};
  return {
    gstin: normalizeGstin(data.gstin),
    legalName: clean(data.lgnm),
    tradeName: clean(data.tradeNam),
    status: clean(data.sts),
    constitution: clean(data.ctb),
    taxpayerType: clean(data.dty),
    registeredOn: clean(data.rgdt),
    cancelledOn: clean(data.cxdt),
    address: formatGstAddress(addr),
    state: clean(addr.stcd),
    pincode: clean(addr.pncd),
    source: "mastersindia",
    fetchedAt: fetchedAt.toISOString(),
  };
};

const providerMessage = (body) => {
  if (!body || typeof body !== "object") return "";
  const candidates = [body.message, body.error_description, body.data];
  if (body.data && typeof body.data === "object")
    candidates.push(body.data.message, body.data.error);
  if (typeof body.error === "string") candidates.push(body.error);
  return clean(candidates.find((v) => typeof v === "string" && v.trim()));
};

const NOT_FOUND_PATTERN =
  /not\s*found|no\s*record|invalid\s*gstin|does\s*not\s*exist|no\s*data/i;

export const createGstinLookup = ({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) => {
  let token = null; // { value, expiresAt }
  let tokenPromise = null;
  const cache = new Map(); // gstin -> { expiresAt, value | error }

  const baseUrl = () =>
    clean(env.MASTERS_INDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = () => {
    const parsed = Number(env.GSTIN_LOOKUP_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  };

  const call = async (url, init) => {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs()),
      });
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

  const fetchToken = async () => {
    const { response, body } = await call(`${baseUrl()}/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        username: env[ENV_KEYS.username],
        password: env[ENV_KEYS.password],
        client_id: env[ENV_KEYS.clientId],
        client_secret: env[ENV_KEYS.clientSecret],
        grant_type: "password",
      }),
    });
    const value = clean(body?.access_token);
    if (!response.ok || !value)
      throw new GstinLookupError(
        "The GST lookup service rejected our login. Check the Masters India credentials on the server.",
        "GSTIN_PROVIDER_AUTH",
        502,
      );
    const seconds = Number(body.expires_in);
    const lifetime =
      (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    token = { value, expiresAt: now() + Math.max(lifetime - 60000, 30000) };
    return value;
  };

  const getToken = async ({ refresh = false } = {}) => {
    if (!refresh && token && token.expiresAt > now()) return token.value;
    if (!tokenPromise)
      tokenPromise = fetchToken().finally(() => {
        tokenPromise = null;
      });
    return tokenPromise;
  };

  const remember = (gstin, entry) => {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(gstin, entry);
  };

  const search = async (gstin, accessToken) =>
    call(
      `${baseUrl()}/commonapis/searchgstin?gstin=${encodeURIComponent(gstin)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          client_id: env[ENV_KEYS.clientId],
        },
      },
    );

  const lookup = async (input) => {
    const gstin = normalizeGstin(input);
    if (!isValidGstin(gstin))
      throw new GstinLookupError(
        "Enter a valid 15-character GSTIN.",
        "GSTIN_INVALID",
        400,
      );
    const status = getGstinLookupStatus(env);
    if (!status.available)
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

    let { response, body } = await search(gstin, await getToken());
    if (response.status === 401 || response.status === 403) {
      ({ response, body } = await search(
        gstin,
        await getToken({ refresh: true }),
      ));
      if (response.status === 401 || response.status === 403)
        throw new GstinLookupError(
          "The GST lookup service rejected our login. Check the Masters India credentials on the server.",
          "GSTIN_PROVIDER_AUTH",
          502,
        );
    }

    const message = providerMessage(body);
    const failed =
      !response.ok || !body || body.error === true || body.error === "true";
    const data =
      !failed && body.data && typeof body.data === "object" ? body.data : null;

    if (failed || !data || !clean(data.gstin || data.lgnm)) {
      if (response.status === 404 || NOT_FOUND_PATTERN.test(message)) {
        const error = new GstinLookupError(
          "No taxpayer is registered with this GSTIN on the GST portal.",
          "GSTIN_NOT_FOUND",
          404,
        );
        remember(gstin, { error, expiresAt: now() + NOT_FOUND_TTL_MS });
        throw error;
      }
      throw new GstinLookupError(
        message
          ? `The GST lookup service couldn't answer: ${message.slice(0, 200)}`
          : "The GST lookup service couldn't answer. Try again.",
        "GSTIN_PROVIDER_ERROR",
        502,
      );
    }

    const value = toTaxpayer({ gstin, ...data }, new Date(now()));
    remember(gstin, { value, expiresAt: now() + RESULT_TTL_MS });
    return { ...value, cached: false };
  };

  return { lookup, getStatus: () => getGstinLookupStatus(env) };
};

const defaultLookup = createGstinLookup();
export const lookupGstin = (gstin) => defaultLookup.lookup(gstin);
