import assert from "node:assert/strict";
import test from "node:test";
import {
  createGstinLookup,
  formatGstAddress,
  getGstinLookupStatus,
  isValidGstin,
} from "../src/services/gstinLookup.js";

const GSTIN = "36HEDPS5768R1Z8";
const ENV = {
  MASTERS_INDIA_USERNAME: "user@example.com",
  MASTERS_INDIA_PASSWORD: "pw",
  MASTERS_INDIA_CLIENT_ID: "client",
  MASTERS_INDIA_CLIENT_SECRET: "secret",
};
const SEARCH_DATA = {
  gstin: GSTIN,
  lgnm: "Ruhi Enterprises",
  tradeNam: "DEEP TRADER",
  sts: "Active",
  ctb: "Proprietorship",
  dty: "Regular",
  rgdt: "27/01/2018",
  cxdt: "",
  pradr: {
    addr: {
      bnm: "",
      st: "RANI KA BAGH",
      loc: "AMRITSAR",
      bno: "135",
      dst: "Amritsar",
      stcd: "Punjab",
      city: "",
      flno: "",
      pncd: "143001",
    },
  },
};

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Fake provider: records calls and answers from a queue per endpoint. */
const fakeProvider = ({ token = [], search = [] } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/oauth/access_token"))
      return (
        token.shift() || json(200, { access_token: "tok-1", expires_in: 21600 })
      );
    return search.shift() || json(200, { error: false, data: SEARCH_DATA });
  };
  return { calls, fetchImpl };
};

test("validates GSTIN shape and check digit", () => {
  assert.equal(isValidGstin(GSTIN), true);
  assert.equal(isValidGstin("27aapfu0939f1zv"), true);
  assert.equal(isValidGstin("27AAPFU0938F1ZV"), false);
  assert.equal(isValidGstin("27AAPFU"), false);
});

test("reports missing credentials by name only", () => {
  assert.deepEqual(getGstinLookupStatus({}).missing, [
    "MASTERS_INDIA_USERNAME",
    "MASTERS_INDIA_PASSWORD",
    "MASTERS_INDIA_CLIENT_ID",
    "MASTERS_INDIA_CLIENT_SECRET",
  ]);
  assert.equal(getGstinLookupStatus(ENV).available, true);
});

test("is disabled without credentials and never calls the provider", async () => {
  const { calls, fetchImpl } = fakeProvider();
  const { lookup } = createGstinLookup({ env: {}, fetchImpl });
  await assert.rejects(
    lookup(GSTIN),
    (e) => e.code === "GSTIN_LOOKUP_DISABLED" && e.statusCode === 503,
  );
  assert.equal(calls.length, 0);
});

test("rejects an invalid GSTIN before calling the provider", async () => {
  const { calls, fetchImpl } = fakeProvider();
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  await assert.rejects(
    lookup("27AAPFU0938F1ZV"),
    (e) => e.code === "GSTIN_INVALID" && e.statusCode === 400,
  );
  assert.equal(calls.length, 0);
});

test("logs in, searches and maps the taxpayer record", async () => {
  const { calls, fetchImpl } = fakeProvider();
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  const result = await lookup(" 36hedps5768r1z8 ");

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/oauth\/access_token$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    username: ENV.MASTERS_INDIA_USERNAME,
    password: ENV.MASTERS_INDIA_PASSWORD,
    client_id: ENV.MASTERS_INDIA_CLIENT_ID,
    client_secret: ENV.MASTERS_INDIA_CLIENT_SECRET,
    grant_type: "password",
  });
  assert.equal(
    calls[1].url,
    `https://commonapi.mastersindia.co/commonapis/searchgstin?gstin=${GSTIN}`,
  );
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok-1");
  assert.equal(calls[1].init.headers.client_id, "client");

  assert.equal(result.gstin, GSTIN);
  assert.equal(result.legalName, "Ruhi Enterprises");
  assert.equal(result.tradeName, "DEEP TRADER");
  assert.equal(result.status, "Active");
  assert.equal(result.address, "135, RANI KA BAGH, AMRITSAR, Punjab - 143001");
  assert.equal(result.state, "Punjab");
  assert.equal(result.pincode, "143001");
  assert.equal(result.cached, false);
  assert.equal(JSON.stringify(result).includes("tok-1"), false);
});

test("reuses the token and caches results per GSTIN", async () => {
  const { calls, fetchImpl } = fakeProvider();
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  await lookup(GSTIN);
  const second = await lookup(GSTIN);
  assert.equal(second.cached, true);
  await lookup("27AAPFU0939F1ZV");
  assert.equal(calls.filter((c) => c.url.includes("access_token")).length, 1);
  assert.equal(calls.filter((c) => c.url.includes("searchgstin")).length, 2);
});

test("refreshes an expired or rejected token once", async () => {
  const { calls, fetchImpl } = fakeProvider({
    token: [
      json(200, { access_token: "old", expires_in: 21600 }),
      json(200, { access_token: "new", expires_in: 21600 }),
    ],
    search: [json(401, { error: true, message: "Unauthorized" })],
  });
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  const result = await lookup(GSTIN);
  assert.equal(result.legalName, "Ruhi Enterprises");
  const searches = calls.filter((c) => c.url.includes("searchgstin"));
  assert.equal(searches[1].init.headers.Authorization, "Bearer new");
});

test("reports bad credentials as a provider auth error", async () => {
  const { fetchImpl } = fakeProvider({
    token: [json(401, { error: "invalid_client" })],
  });
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  await assert.rejects(
    lookup(GSTIN),
    (e) => e.code === "GSTIN_PROVIDER_AUTH" && e.statusCode === 502,
  );
});

test("maps an unknown GSTIN to 404 and other provider errors to 502", async () => {
  const { fetchImpl } = fakeProvider({
    search: [
      json(200, { error: true, data: "No records found for this GSTIN" }),
      json(200, { error: true, message: "Service temporarily unavailable" }),
    ],
  });
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  await assert.rejects(
    lookup(GSTIN),
    (e) => e.code === "GSTIN_NOT_FOUND" && e.statusCode === 404,
  );
  await assert.rejects(
    lookup("27AAPFU0939F1ZV"),
    (e) =>
      e.code === "GSTIN_PROVIDER_ERROR" &&
      e.statusCode === 502 &&
      /temporarily unavailable/.test(e.message),
  );
});

test("maps timeouts and network failures", async () => {
  const timeout = createGstinLookup({
    env: ENV,
    fetchImpl: async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    },
  });
  await assert.rejects(
    timeout.lookup(GSTIN),
    (e) => e.code === "GSTIN_PROVIDER_TIMEOUT" && e.statusCode === 504,
  );
  const offline = createGstinLookup({
    env: ENV,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    offline.lookup(GSTIN),
    (e) => e.code === "GSTIN_PROVIDER_UNREACHABLE" && e.statusCode === 502,
  );
});

test("formats addresses without blanks or repeated parts", () => {
  assert.equal(
    formatGstAddress({
      flno: "2nd Floor",
      bno: "8-2-293",
      st: "Road No 12",
      loc: "Hyderabad",
      city: "Hyderabad",
      dst: "Hyderabad",
      stcd: "Telangana",
      pncd: "500034",
    }),
    "2nd Floor, 8-2-293, Road No 12, Hyderabad, Telangana - 500034",
  );
  assert.equal(formatGstAddress({}), "");
});
