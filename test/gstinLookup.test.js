import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_GSTIN,
  createGstinLookup,
  formatGstAddress,
  getGstinLookupStatus,
  isValidGstin,
  toTaxpayer,
} from "../src/services/gstinLookup.js";

// GSTIN lookup via gstinapi.in, with a fake provider (no network, no key).
// Response shapes follow https://gstinapi.in/openapi.json.

const GSTIN = "33AAACC1206D1ZN";
const ENV = { GST_ENABLE_KEY: "gak_test_key" };
const RECORD = {
  gstin: GSTIN,
  legal_name: "CENTRAL WAREHOUSING CORPORATION",
  trade_name: "CENTRAL WAREHOUSING CORPORATION",
  status: "Active",
  taxpayer_type: "Regular",
  business_constitution: null,
  registration_date: "2017-07-01",
  cancellation_date: null,
  state_code: "33",
  address: "No.4, North Avenue, Saidapet, Chennai",
  city: "Saidapet, Chennai",
  address_details: {
    building_number: "4",
    building_name: "Thiruvalar Illam",
    floor: null,
    street: "North Avenue",
    locality: "Srinagar Colony, Saidapet",
    district: null,
    city: null,
    state: "Tamil Nadu",
    landmark: null,
    pincode: "600015",
  },
  pincode: "600015",
  block_status: "Unblocked",
};

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const success = (data = RECORD) =>
  json(200, {
    success: true,
    gstin: data.gstin,
    data,
    billed_to: "free",
    credits_remaining: 74,
  });

/** Fake provider: records calls and answers from a queue. */
const fakeProvider = (responses = []) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responses.shift() || success();
  };
  return { calls, fetchImpl };
};

test("validates GSTIN shape and check digit", () => {
  assert.equal(isValidGstin(GSTIN), true);
  assert.equal(isValidGstin("36HEDPS5768R1Z8"), true);
  assert.equal(isValidGstin("27aapfu0939f1zv"), true);
  assert.equal(isValidGstin("27AAPFU0938F1ZV"), false);
  assert.equal(isValidGstin("27AAPFU"), false);
});

test("reports a missing API key by name only", () => {
  assert.deepEqual(getGstinLookupStatus({}).missing, ["GST_ENABLE_KEY"]);
  assert.equal(getGstinLookupStatus(ENV).available, true);
  assert.equal(getGstinLookupStatus(ENV).provider, "gstinapi");
});

test("is disabled without a key and never calls the provider", async () => {
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

test("calls GET /v1/gstin/:gstin with x-api-key and maps the record", async () => {
  const { calls, fetchImpl } = fakeProvider();
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  const result = await lookup(" 33aaacc1206d1zn ");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://www.gstinapi.in/v1/gstin/${GSTIN}`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["x-api-key"], "gak_test_key");

  assert.equal(result.gstin, GSTIN);
  assert.equal(result.legalName, "CENTRAL WAREHOUSING CORPORATION");
  assert.equal(result.status, "Active");
  assert.equal(result.taxpayerType, "Regular");
  assert.equal(result.registeredOn, "2017-07-01");
  assert.equal(result.cancelledOn, "");
  assert.equal(result.constitution, "");
  assert.equal(
    result.address,
    "4, Thiruvalar Illam, North Avenue, Srinagar Colony, Saidapet, Tamil Nadu - 600015",
  );
  assert.equal(result.state, "Tamil Nadu");
  assert.equal(result.stateCode, "33");
  assert.equal(result.pincode, "600015");
  assert.equal(result.source, "gstinapi");
  assert.equal(result.creditsRemaining, 74);
  assert.equal(result.cached, false);
  assert.equal(JSON.stringify(result).includes("gak_test_key"), false);
});

test("caches results per GSTIN (credits are paid)", async () => {
  const { calls, fetchImpl } = fakeProvider();
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  await lookup(GSTIN);
  const second = await lookup(GSTIN);
  assert.equal(second.cached, true);
  await lookup("36HEDPS5768R1Z8");
  assert.equal(calls.length, 2);
});

test("the provider's sandbox GSTIN is allowed (free test)", async () => {
  const { calls, fetchImpl } = fakeProvider([
    json(200, {
      success: true,
      gstin: SANDBOX_GSTIN,
      test: true,
      data: { ...RECORD, gstin: SANDBOX_GSTIN, legal_name: "GSTINAPI TEST" },
    }),
  ]);
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  const result = await lookup(SANDBOX_GSTIN);
  assert.equal(calls.length, 1);
  assert.equal(result.legalName, "GSTINAPI TEST");
  assert.equal(result.test, true);
});

test("maps provider errors to our codes", async () => {
  const cases = [
    [404, "GSTIN_NOT_FOUND", 404],
    [401, "GSTIN_PROVIDER_AUTH", 502],
    [403, "GSTIN_PROVIDER_AUTH", 502],
    [402, "GSTIN_PROVIDER_NO_CREDITS", 502],
    [429, "GSTIN_PROVIDER_RATE_LIMITED", 429],
    [502, "GSTIN_PROVIDER_ERROR", 502],
    [400, "GSTIN_INVALID", 400],
  ];
  for (const [status, code, statusCode] of cases) {
    const { fetchImpl } = fakeProvider([
      json(status, { success: false, error: `provider says ${status}` }),
    ]);
    const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
    await assert.rejects(
      lookup(GSTIN),
      (e) => e.code === code && e.statusCode === statusCode,
      `provider ${status}`,
    );
  }
  // A 200 without a record is a provider error, with its message.
  const { fetchImpl } = fakeProvider([
    json(200, { success: false, error: "Upstream busy" }),
  ]);
  const { lookup } = createGstinLookup({ env: ENV, fetchImpl });
  await assert.rejects(
    lookup(GSTIN),
    (e) =>
      e.code === "GSTIN_PROVIDER_ERROR" &&
      e.statusCode === 502 &&
      /Upstream busy/.test(e.message),
  );
});

test("caches not-found for an hour so a typo is not paid twice", async () => {
  let clock = 0;
  const { calls, fetchImpl } = fakeProvider([
    json(404, { success: false, error: "GSTIN not found in GST database" }),
    json(404, { success: false, error: "GSTIN not found in GST database" }),
  ]);
  const { lookup } = createGstinLookup({
    env: ENV,
    fetchImpl,
    now: () => clock,
  });
  await assert.rejects(lookup(GSTIN), (e) => e.code === "GSTIN_NOT_FOUND");
  await assert.rejects(lookup(GSTIN), (e) => e.code === "GSTIN_NOT_FOUND");
  assert.equal(calls.length, 1);
  clock += 61 * 60 * 1000;
  await assert.rejects(lookup(GSTIN), (e) => e.code === "GSTIN_NOT_FOUND");
  assert.equal(calls.length, 2);
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

test("formats addresses without blanks or repeated parts; falls back to the one-line address", () => {
  assert.equal(
    formatGstAddress({
      floor: "2nd Floor",
      building_number: "8-2-293",
      street: "Road No 12",
      locality: "Hyderabad",
      city: "Hyderabad",
      district: "Hyderabad",
      state: "Telangana",
      pincode: "500034",
    }),
    "2nd Floor, 8-2-293, Road No 12, Hyderabad, Telangana - 500034",
  );
  assert.equal(formatGstAddress({}), "");
  assert.equal(
    toTaxpayer({
      gstin: GSTIN,
      address: "1 Main Road, Chennai",
      pincode: "600001",
    }).address,
    "1 Main Road, Chennai - 600001",
  );
});
