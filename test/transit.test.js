import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { createTransitService } from "../src/services/transit/service.js";
import {
  createRateComparison,
  benchmarkFare,
} from "../src/services/transit/comparison.js";
import { parseTransitText } from "../src/services/transit/extraction.js";
import {
  TransitError,
  paymentSummary,
  tierForDistance,
  validateRateCardInput,
  validateSubmission,
  validateTiers,
} from "../src/services/transit/rules.js";
import { assertSnapshotUntouched } from "../src/models/transit/transit.js";
import { stripTransitOwnedFields } from "../src/models/crm/invoice.js";
import { validateInvoicePayload } from "../src/controllers/crm/invoice.js";
import {
  classifyGeocode,
  createGoogleMapsProvider,
} from "../src/services/routing/googleMaps.js";
import { RoutingError } from "../src/services/routing/errors.js";
import { routingProvider } from "../src/services/routing/index.js";
import {
  classifyNominatim,
  createOsmProvider,
  resetNominatimThrottle,
} from "../src/services/routing/osm.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import AquaAdminUser from "../src/models/crm/adminUser.js";
import transitRoutes from "../src/routes/crm/transit.js";
import {
  applyUpdate,
  clone,
  createClock,
  matches,
} from "./support/mcpFakes.js";

// Transit against in-memory fakes: no database, no Google Maps, no Gemini,
// no WhatsApp. The fake store applies the same snapshot guard as the model.

const TRANSPORTER = "a00000000000000000000001";
const OTHER_TRANSPORTER = "a00000000000000000000002";
const ADMIN = "a00000000000000000000009";
const PRODUCT = "b00000000000000000000001";
const PRODUCT_2 = "b00000000000000000000002";

const RATE_CARD = {
  name: "V1",
  tiers: [
    { minKm: 0, maxKm: 10, price: 350 },
    { minKm: 10, maxKm: 15, price: 400 },
    { minKm: 15, maxKm: null, price: 500 },
  ],
  cashIncentive: 100,
};

const actor = (userId, permissions) => ({
  id: userId,
  name: userId === ADMIN ? "Admin" : "Ravi Transport",
  can: (permission) => permissions.includes(permission),
});
const transporter = actor(TRANSPORTER, ["transit.operate"]);
const otherTransporter = actor(OTHER_TRANSPORTER, ["transit.operate"]);
const admin = actor(ADMIN, [
  "transit.read",
  "transit.manage",
  "transit.settle",
]);
const reader = actor("a00000000000000000000008", ["transit.read"]);

const duplicateKey = () =>
  Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

const createStore = (clock) => {
  let counter = 0;
  const newId = () => (++counter).toString(16).padStart(24, "c");
  const db = {
    transits: [],
    invoices: [],
    warehouses: [],
    cards: [],
    benchmarks: [],
    batches: [],
    paymentUpdates: [],
    linkedCustomers: [],
    invoiceCorrections: [],
  };
  const byId = (list, id) => list.find((doc) => String(doc._id) === String(id));
  const products = [
    {
      productId: PRODUCT,
      name: "Automatic Softener 8L",
      slug: "softener-8l",
      sellingPrice: 18500,
    },
    { productId: PRODUCT_2, name: "Salt bag", slug: "salt", sellingPrice: 500 },
  ];
  return {
    db,
    newId,
    loadProducts: async (ids) =>
      products.filter((p) => ids.includes(p.productId)),
    getActiveWarehouse: async () =>
      clone(db.warehouses.find((w) => w.isActive)) || null,
    replaceActiveWarehouse: async (doc) => {
      db.warehouses.forEach((w) => {
        w.isActive = false;
      });
      const saved = { _id: newId(), ...clone(doc) };
      db.warehouses.push(saved);
      return clone(saved);
    },
    listRateCards: async () => clone(db.cards),
    listActiveRateCards: async () =>
      clone(db.cards.filter((c) => c.status === "active")),
    findRateCard: async (id) => clone(byId(db.cards, id)) || null,
    createRateCard: async (doc) => {
      const saved = { _id: newId(), ...clone(doc) };
      db.cards.push(saved);
      return clone(saved);
    },
    updateRateCard: async (id, update) =>
      clone(applyUpdate(byId(db.cards, id), update)),
    listBenchmarks: async ({ activeOnly } = {}) =>
      clone(db.benchmarks.filter((b) => !activeOnly || b.isActive)),
    findBenchmark: async (id) => clone(byId(db.benchmarks, id)) || null,
    createBenchmark: async (doc) => {
      const saved = { _id: newId(), ...clone(doc) };
      db.benchmarks.push(saved);
      return clone(saved);
    },
    updateBenchmark: async (id, update) =>
      clone(applyUpdate(byId(db.benchmarks, id), update)),
    findTransit: async (id) => clone(byId(db.transits, id)) || null,
    findTransitByKey: async (transporterId, key) =>
      clone(
        db.transits.find(
          (t) =>
            String(t.transporterId) === String(transporterId) &&
            t.idempotencyKey === key,
        ),
      ) || null,
    createTransit: async (doc) => {
      if (
        db.transits.some(
          (t) =>
            String(t.transporterId) === String(doc.transporterId) &&
            t.idempotencyKey === doc.idempotencyKey,
        )
      )
        throw duplicateKey();
      const saved = { _id: newId(), ...clone(doc), createdAt: clock.now() };
      db.transits.push(saved);
      return clone(saved);
    },
    updateTransit: async (id, condition, update, options) => {
      assertSnapshotUntouched(update, options);
      const doc = byId(db.transits, id);
      if (!doc || !matches(doc, condition)) return null;
      applyUpdate(doc, update);
      return clone(doc);
    },
    listTransits: async ({ filter, skip, limit }) => {
      const items = db.transits.filter((t) => matches(t, filter));
      return {
        items: clone(items.slice(skip, skip + limit)),
        total: items.length,
      };
    },
    findTransits: async (filter) =>
      clone(db.transits.filter((t) => matches(t, filter))),
    settleTransits: async (filter, update) => {
      const hits = db.transits.filter((t) => matches(t, filter));
      hits.forEach((t) => applyUpdate(t, update));
      return hits.length;
    },
    findInvoiceById: async (id) => clone(byId(db.invoices, id)) || null,
    findInvoiceByTransit: async (transitId) =>
      clone(
        db.invoices.find(
          (i) => String(i.sourceTransitId) === String(transitId),
        ),
      ) || null,
    setInvoicePayment: async (invoiceId, set) => {
      db.paymentUpdates.push({ invoiceId, ...set });
      Object.assign(byId(db.invoices, invoiceId), set);
    },
    correctInvoiceDelivery: async (invoiceId, change) => {
      db.invoiceCorrections.push({ invoiceId, ...clone(change) });
    },
    linkCustomer: async (invoice) => {
      db.linkedCustomers.push(String(invoice._id));
    },
    findSettlementBatchByKey: async (key) =>
      clone(db.batches.find((b) => b.idempotencyKey === key)) || null,
    createSettlementBatch: async (doc) => {
      if (db.batches.some((b) => b.idempotencyKey === doc.idempotencyKey))
        throw duplicateKey();
      const saved = { _id: newId(), ...clone(doc) };
      db.batches.push(saved);
      return clone(saved);
    },
    updateSettlementBatch: async (id, update) =>
      clone(applyUpdate(byId(db.batches, id), update)),
    listSettlementBatches: async ({ skip, limit }) => ({
      items: clone(db.batches.slice(skip, skip + limit)),
      total: db.batches.length,
    }),
  };
};

const setup = ({
  routing: routingOverrides = {},
  deliver,
  persistFailure,
} = {}) => {
  const clock = createClock("2026-11-23T05:00:00.000Z");
  const store = createStore(clock);
  const calls = {
    geocode: 0,
    route: 0,
    deliveries: [],
    persisted: 0,
    audits: [],
  };
  let invoiceCounter = 0;
  const routing = {
    name: "fake-maps",
    geocode: async (address) => {
      calls.geocode += 1;
      return {
        status: "ok",
        match: {
          lat: 17.46,
          lng: 78.28,
          placeId: "place-1",
          formattedAddress: `${address}, Telangana`,
        },
      };
    },
    route: async () => {
      calls.route += 1;
      return { distanceMeters: 12_400, durationSeconds: 1500, polyline: "abc" };
    },
    ...routingOverrides,
  };
  const invoiceWriter = {
    validate: (payload) => validateInvoicePayload(payload),
    assertStock: async () => {},
    persist: async (payload) => {
      if (persistFailure) {
        const error = persistFailure();
        if (error) throw error;
      }
      if (
        store.db.invoices.some(
          (i) => String(i.sourceTransitId) === String(payload.sourceTransitId),
        )
      )
        throw duplicateKey();
      calls.persisted += 1;
      invoiceCounter += 1;
      const invoice = {
        _id: store.newId(),
        invoiceNo: `AQB-TEST-${invoiceCounter}`,
        ...clone(payload),
      };
      store.db.invoices.push(invoice);
      return { invoice: clone(invoice) };
    },
  };
  const service = createTransitService({
    store,
    invoiceWriter,
    routing,
    parse: async () => ({ ready: true }),
    notifier: {
      deliverInvoice: async (args) => {
        calls.deliveries.push(args.dedupePrefix);
        return deliver ? deliver(args) : { success: true, channel: "whatsapp" };
      },
    },
    comparison: createRateComparison(),
    audit: async (entry) => {
      calls.audits.push(entry.action);
    },
    now: () => clock.now(),
  });
  return { service, store, calls, clock, invoiceWriter };
};

const configure = async (service) => {
  await service.setWarehouse(
    {
      name: "Aquakart Warehouse",
      address: "Kukatpally, Hyderabad",
      lat: 17.49,
      lng: 78.39,
    },
    admin,
  );
  await service.createRateCard(
    { ...RATE_CARD, effectiveFrom: "2026-11-01T00:00:00Z" },
    admin,
  );
};

const submission = (overrides = {}) => ({
  customer: {
    name: "Ramesh",
    phone: "9876543210",
    address: "Near school, Tellapur, Hyderabad 502032",
  },
  items: [{ productId: PRODUCT, quantity: 1, unitPrice: 18500 }],
  ...overrides,
});

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });

// ---- Pricing tiers ---------------------------------------------------------------

test("pricing tiers: boundaries belong to the lower tier", () => {
  const { tiers, errors } = validateTiers(RATE_CARD.tiers);
  assert.deepEqual(errors, []);
  const price = (km) => tierForDistance(tiers, km).price;
  assert.equal(price(0), 350);
  assert.equal(price(10), 350);
  assert.equal(price(10.004), 350); // rounds to 10.00 km
  assert.equal(price(10.01), 400);
  assert.equal(price(15), 400);
  assert.equal(price(15.01), 500);
  assert.equal(price(250), 500);
});

test("pricing tiers: gaps, overlaps and uncovered distances are refused", () => {
  const errors = (tiers) => validateTiers(tiers).errors.join(" | ");
  assert.match(
    errors([
      { minKm: 0, maxKm: 10, price: 1 },
      { minKm: 12, maxKm: null, price: 2 },
    ]),
    /Gap/,
  );
  assert.match(
    errors([
      { minKm: 0, maxKm: 10, price: 1 },
      { minKm: 8, maxKm: null, price: 2 },
    ]),
    /overlap/,
  );
  assert.match(errors([{ minKm: 0, maxKm: 10, price: 1 }]), /open-ended/);
  assert.match(errors([{ minKm: 2, maxKm: null, price: 1 }]), /start at 0/);
  assert.match(errors([{ minKm: 0, maxKm: null, price: -5 }]), /price/);
  assert.throws(
    () =>
      validateRateCardInput({
        name: "x",
        tiers: RATE_CARD.tiers,
        cashIncentive: -1,
      }),
    (error) => error.code === "INVALID_RATE_CARD",
  );
});

test("rate cards: a newer card takes over at its start; prices can't be edited in place", async () => {
  const { service, clock } = setup();
  await configure(service);
  await service.createRateCard(
    {
      name: "December",
      tiers: [
        { minKm: 0, maxKm: 10, price: 375 },
        { minKm: 10, maxKm: null, price: 450 },
      ],
      cashIncentive: 120,
      effectiveFrom: "2026-12-01T00:00:00Z",
    },
    admin,
  );
  let cards = await service.listRateCards();
  assert.equal(cards.find((c) => c.inForce).name, "V1");
  clock.advance(10 * 24 * 60 * 60 * 1000); // into December
  cards = await service.listRateCards();
  assert.equal(cards.find((c) => c.inForce).name, "December");
  await rejectsWith(
    service.updateRateCard(cards[0]._id, { tiers: RATE_CARD.tiers }, admin),
    "RATE_CARD_IMMUTABLE",
  );
  await rejectsWith(
    service.createRateCard(RATE_CARD, transporter),
    "FORBIDDEN",
  );
});

// ---- Gemini parsing --------------------------------------------------------------

const catalog = [
  {
    productId: PRODUCT,
    name: "Automatic Softener 8L",
    brand: "Aquakart",
    sellingPrice: 18500,
  },
  {
    productId: PRODUCT_2,
    name: "Salt bag",
    brand: "Aquakart",
    sellingPrice: 500,
  },
];
const geminiReply = (body) => async () => ({
  text: typeof body === "string" ? body : JSON.stringify(body),
});
const parseDeps = (body) => ({
  generate: geminiReply(body),
  loadCatalog: async () => catalog,
  loadStock: async () => new Map([[PRODUCT, 5]]),
});

test("parsing: complete text becomes structured details; payment fields from AI are dropped", async () => {
  const source =
    "Ramesh, Tellapur near school, automatic softener 8L, 18500, phone 9876543210, paid cash";
  const parsed = await parseTransitText(
    source,
    parseDeps({
      name: "Ramesh",
      phone: "9876543210",
      address: "Tellapur near school",
      paidStatus: "paid",
      paymentType: "cash",
      products: [
        {
          productName: "automatic softener 8L",
          quantity: null,
          unitPrice: 18500,
        },
      ],
    }),
  );
  assert.equal(parsed.ready, true);
  assert.equal(parsed.customer.phone.value, "9876543210");
  assert.equal(parsed.customer.address.status, "extracted");
  assert.equal(parsed.items[0].productId, PRODUCT);
  assert.equal(parsed.items[0].unitPrice, 18500);
  assert.equal("paidStatus" in parsed, false);
  assert.equal("paymentType" in parsed, false);
});

test("parsing: masked phone, missing price and invented numbers become corrections", async () => {
  const source =
    "Ramesh, Tellapur near school, automatic softener 8L, phone 9XXXXXXXXX";
  const parsed = await parseTransitText(
    source,
    parseDeps({
      name: "Ramesh",
      phone: "9123456789", // not in the text: rejected
      address: "Tellapur near school",
      products: [
        {
          productName: "automatic softener 8L",
          quantity: null,
          unitPrice: 18500,
        },
      ], // not in the text
    }),
  );
  assert.equal(parsed.ready, false);
  const codes = parsed.corrections.map((c) => c.code);
  assert.ok(codes.includes("PHONE_UNREADABLE"), codes.join());
  assert.ok(codes.includes("PRICE_MISSING"), codes.join());
  assert.equal(parsed.customer.phone.value, "");
  assert.equal(parsed.items[0].unitPrice, null);
});

test("parsing: missing customer details and unknown products are reported, not invented", async () => {
  const parsed = await parseTransitText(
    "kent water purifier 12000",
    parseDeps({
      name: "",
      phone: "",
      address: "",
      products: [{ productName: "kent water purifier", unitPrice: 12000 }],
    }),
  );
  const codes = parsed.corrections.map((c) => c.code);
  for (const code of [
    "NAME_MISSING",
    "PHONE_MISSING",
    "ADDRESS_MISSING",
    "PRODUCT_NOT_MATCHED",
  ])
    assert.ok(codes.includes(code), `${code} in ${codes.join()}`);
  assert.equal(parsed.items[0].productId, null);
});

test("parsing: an unreadable Gemini answer fails cleanly", async () => {
  await assert.rejects(
    parseTransitText("Ramesh 9876543210", parseDeps("not json at all")),
    (error) => error.statusCode === 502,
  );
});

// ---- Submission validation -------------------------------------------------------------

test("submission: missing customer details are refused before anything is computed", async () => {
  const { service, calls } = setup();
  await configure(service);
  await assert.rejects(
    service.submit(
      submission({ customer: { name: "", phone: "98765", address: "" } }),
      transporter,
      "key-missing-details",
    ),
    (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      const fields = error.details.map((d) => d.field);
      assert.deepEqual(fields.sort(), [
        "customer.address",
        "customer.name",
        "customer.phone",
      ]);
      return true;
    },
  );
  assert.equal(calls.geocode, 0);
  assert.throws(
    () =>
      validateSubmission({
        ...submission(),
        items: [{ productId: PRODUCT, unitPrice: 0 }],
      }),
    TransitError,
  );
});

// ---- Routing failures -------------------------------------------------------------

test("routing: provider failures and ambiguous destinations block submission", async () => {
  const cases = [
    [
      {
        geocode: async () => {
          throw new RoutingError(503, "ROUTING_NOT_CONFIGURED", "no key");
        },
      },
      "ROUTING_NOT_CONFIGURED",
    ],
    [
      { geocode: async () => ({ status: "not_found" }) },
      "DESTINATION_NOT_FOUND",
    ],
    [
      {
        geocode: async () => ({
          status: "ambiguous",
          candidates: [{ lat: 17.4, lng: 78.2, formattedAddress: "Tellapur" }],
        }),
      },
      "DESTINATION_AMBIGUOUS",
    ],
    [
      {
        route: async () => {
          throw new RoutingError(422, "ROUTE_NOT_FOUND", "no route");
        },
      },
      "ROUTE_NOT_FOUND",
    ],
    [
      {
        route: async () => {
          throw new Error("socket hang up");
        },
      },
      "ROUTING_PROVIDER_ERROR",
    ],
  ];
  for (const [routing, code] of cases) {
    const { service, store } = setup({ routing });
    await configure(service);
    await rejectsWith(
      service.submit(submission(), transporter, `key-${code}`),
      code,
    );
    assert.equal(store.db.transits.length, 0, `${code}: no transit`);
    assert.equal(store.db.invoices.length, 0, `${code}: no invoice`);
  }
  const ambiguous = setup({ routing: cases[2][0] });
  await configure(ambiguous.service);
  await assert.rejects(ambiguous.service.preview(submission()), (error) => {
    assert.equal(error.details.candidates.length, 1);
    return true;
  });
});

test("routing: a pinned location skips geocoding; no warehouse or rate card blocks pricing", async () => {
  const { service, calls } = setup();
  await rejectsWith(service.preview(submission()), "WAREHOUSE_NOT_CONFIGURED");
  await service.setWarehouse(
    { name: "W", address: "Kukatpally", lat: 17.49, lng: 78.39 },
    admin,
  );
  await rejectsWith(service.preview(submission()), "PRICING_NOT_CONFIGURED");
  await service.createRateCard(
    { ...RATE_CARD, effectiveFrom: "2026-11-01T00:00:00Z" },
    admin,
  );
  const preview = await service.preview(
    submission({ destination: { lat: 17.45, lng: 78.27 } }),
  );
  assert.equal(calls.geocode, 0);
  assert.equal(preview.delivery.destination.source, "pinned");
  assert.equal(preview.delivery.distanceKm, 12.4);
  assert.equal(preview.transport.baseCharge, 400);
  assert.equal(preview.transport.cashIncentiveIfCashCollected, 100);
});

test("Google provider: coarse or conflicting results are ambiguous; road distance is parsed", async () => {
  const precise = {
    formatted_address: "Plot 12, Tellapur",
    place_id: "p1",
    types: ["premise"],
    geometry: {
      location: { lat: 17.46, lng: 78.28 },
      location_type: "ROOFTOP",
    },
  };
  const locality = {
    formatted_address: "Tellapur, Telangana",
    place_id: "p2",
    types: ["locality"],
    geometry: {
      location: { lat: 17.47, lng: 78.29 },
      location_type: "APPROXIMATE",
    },
  };
  assert.equal(classifyGeocode([precise]).status, "ok");
  assert.equal(classifyGeocode([locality]).status, "ambiguous");
  assert.equal(
    classifyGeocode([
      precise,
      {
        ...precise,
        geometry: {
          location: { lat: 17.6, lng: 78.5 },
          location_type: "ROOFTOP",
        },
      },
    ]).status,
    "ambiguous",
  );
  assert.equal(classifyGeocode([]).status, "not_found");

  const requests = [];
  const http = {
    get: async (url, options) => {
      requests.push({ url, params: options.params });
      return { data: { status: "OK", results: [precise] } };
    },
    post: async (url, body, options) => {
      requests.push({ url, body, headers: options.headers });
      return {
        data: {
          routes: [
            {
              distanceMeters: 15010,
              duration: "1800s",
              polyline: { encodedPolyline: "xyz" },
            },
          ],
        },
      };
    },
  };
  const provider = createGoogleMapsProvider({ apiKey: "test-key", http });
  const found = await provider.geocode("Plot 12, Tellapur", {
    near: { lat: 17.49, lng: 78.39 },
  });
  assert.equal(found.status, "ok");
  assert.equal(requests[0].params.components, "country:IN");
  const route = await provider.route(
    { lat: 17.49, lng: 78.39 },
    { lat: 17.46, lng: 78.28 },
  );
  assert.deepEqual(route, {
    distanceMeters: 15010,
    durationSeconds: 1800,
    polyline: "xyz",
  });
  assert.equal(requests[1].body.travelMode, "DRIVE");
  assert.equal(requests[1].headers["X-Goog-Api-Key"], "test-key");

  const empty = createGoogleMapsProvider({
    apiKey: "k",
    http: { post: async () => ({ data: {} }) },
  });
  await rejectsWith(
    empty.route({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    "ROUTE_NOT_FOUND",
  );
  await rejectsWith(
    routingProvider({ TRANSIT_ROUTING_PROVIDER: "google" }).route({}, {}),
    "ROUTING_NOT_CONFIGURED",
  );
});

test("routing: keyless OSM provider is the default and never guesses", async () => {
  assert.equal(routingProvider({}).name, "osm");
  assert.equal(routingProvider({}).configured, true);
  await rejectsWith(
    routingProvider({ TRANSIT_ROUTING_PROVIDER: "nope" }).route({}, {}),
    "ROUTING_NOT_CONFIGURED",
  );

  const house = {
    place_id: 1,
    osm_type: "way",
    osm_id: 42,
    lat: "17.4612",
    lon: "78.2841",
    place_rank: 30,
    display_name: "ZPHS School, Tellapur, Telangana",
  };
  const locality = { ...house, osm_id: 43, place_rank: 16, lat: "17.47" };
  assert.equal(classifyNominatim([house]).status, "ok");
  assert.equal(classifyNominatim([house]).match.placeId, "osm:way/42");
  assert.equal(classifyNominatim([locality]).status, "ambiguous");
  assert.equal(
    classifyNominatim([house, { ...house, osm_id: 44, lat: "17.6" }]).status,
    "ambiguous",
  );
  assert.equal(classifyNominatim([]).status, "not_found");

  resetNominatimThrottle();
  const requests = [];
  const waits = [];
  let now = 1_000_000;
  const ok = {
    code: "Ok",
    routes: [{ distance: 12410.6, duration: 1500.4, geometry: "abc" }],
    waypoints: [{ distance: 12 }, { distance: 40 }],
  };
  let routeAnswer = ok;
  const http = {
    get: async (url, options) => {
      requests.push({ url, params: options.params, headers: options.headers });
      return url.includes("/route/")
        ? { data: routeAnswer }
        : { data: [house] };
    },
  };
  const provider = createOsmProvider({
    http,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    clock: () => now,
  });
  const found = await provider.geocode("Tellapur near school", {
    near: { lat: 17.49, lng: 78.39 },
  });
  assert.equal(found.status, "ok");
  assert.equal(requests[0].params.countrycodes, "in");
  assert.match(requests[0].headers["User-Agent"], /AquakartTransit/);
  // A second lookup within the same second waits for Nominatim's limit.
  await provider.geocode("Tellapur near school");
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 1_100);

  const route = await provider.route(
    { lat: 17.49, lng: 78.39 },
    { lat: 17.4612, lng: 78.2841 },
  );
  assert.deepEqual(route, {
    distanceMeters: 12410.6,
    durationSeconds: 1500,
    polyline: "abc",
  });
  // OSRM takes lng,lat.
  assert.match(
    requests[2].url,
    /driving\/78\.390000,17\.490000;78\.284100,17\.461200$/,
  );

  routeAnswer = { code: "NoRoute", routes: [] };
  await rejectsWith(
    provider.route({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    "ROUTE_NOT_FOUND",
  );
  routeAnswer = { ...ok, waypoints: [{ distance: 5 }, { distance: 2400 }] };
  await rejectsWith(
    provider.route({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    "ROUTE_NOT_FOUND",
  );
  routeAnswer = { code: "TooBig" };
  await rejectsWith(
    provider.route({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    "ROUTING_PROVIDER_ERROR",
  );
  const down = createOsmProvider({
    http: {
      get: async () => {
        throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
      },
    },
  });
  await rejectsWith(
    down.route({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    "ROUTING_PROVIDER_ERROR",
  );
});

// ---- Submission, idempotency and invoices --------------------------------------------------

test("submission: creates one invoice with the delivery snapshot and sends it", async () => {
  const { service, store, calls } = setup();
  await configure(service);
  const { transit, replayed } = await service.submit(
    submission(),
    transporter,
    "key-first-0001",
  );
  assert.equal(replayed, false);
  assert.equal(transit.status, "invoiced");
  assert.equal(transit.pricing.baseCharge, 400);
  assert.equal(transit.payout.totalPayable, 400);
  assert.equal(transit.payout.settlementStatus, "UNSETTLED");
  assert.equal(transit.customerPayment.status, "unpaid");
  assert.equal(transit.invoiceDelivery.status, "accepted");
  const [invoice] = store.db.invoices;
  assert.equal(String(invoice.sourceTransitId), transit.id);
  assert.equal(invoice.transitDelivery.distanceKm, 12.4);
  assert.equal(invoice.transitDelivery.destination.lat, 17.46);
  assert.equal(invoice.transitDelivery.snapshotHash, transit.snapshotHash);
  assert.equal(invoice.paidStatus, "unpaid");
  // Selling price is untouched by the transport charge.
  assert.equal(invoice.products[0].productPrice, 18500);
  assert.equal(invoice.transport.deliveredBy, "Ravi Transport");
  assert.equal(store.db.linkedCustomers.length, 1);
  assert.deepEqual(calls.deliveries, [`transit:${transit.id}:invoice:1`]);
});

test("submission: a repeated key returns the same transit; a reused key with new data is refused", async () => {
  const { service, store, calls } = setup();
  await configure(service);
  const first = await service.submit(
    submission(),
    transporter,
    "key-repeat-0001",
  );
  const again = await service.submit(
    submission(),
    transporter,
    "key-repeat-0001",
  );
  assert.equal(again.replayed, true);
  assert.equal(again.transit.id, first.transit.id);
  assert.equal(store.db.transits.length, 1);
  assert.equal(store.db.invoices.length, 1);
  assert.equal(calls.deliveries.length, 1);
  await rejectsWith(
    service.submit(
      submission({
        items: [{ productId: PRODUCT_2, quantity: 2, unitPrice: 500 }],
      }),
      transporter,
      "key-repeat-0001",
    ),
    "IDEMPOTENCY_KEY_REUSED",
  );
  // Another transporter's key space is separate.
  const other = await service.submit(
    submission(),
    otherTransporter,
    "key-repeat-0001",
  );
  assert.notEqual(other.transit.id, first.transit.id);
});

test("submission: concurrent identical requests create one transit and one invoice", async () => {
  const { service, store } = setup();
  await configure(service);
  const results = await Promise.allSettled([
    service.submit(submission(), transporter, "key-concurrent-1"),
    service.submit(submission(), transporter, "key-concurrent-1"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.ok(ok.length >= 1);
  for (const r of results.filter((r) => r.status === "rejected"))
    assert.equal(r.reason.code, "SUBMISSION_IN_PROGRESS");
  assert.equal(store.db.transits.length, 1);
  assert.equal(store.db.invoices.length, 1);
});

test("duplicate invoices: a retry after a crash reuses the invoice already written", async () => {
  let crash = true;
  const { service, store, calls, clock } = setup();
  await configure(service);
  // The invoice is written, then the process dies before the transit is updated.
  const realUpdate = store.updateTransit;
  store.updateTransit = async (id, condition, update, options) => {
    if (crash && update.$set?.status === "invoiced") {
      crash = false;
      throw new Error("process crashed");
    }
    return realUpdate(id, condition, update, options);
  };
  await assert.rejects(
    service.submit(submission(), transporter, "key-crash-00001"),
  );
  assert.equal(store.db.invoices.length, 1);
  clock.advance(3 * 60 * 1000); // lock expired
  const retried = await service.submit(
    submission(),
    transporter,
    "key-crash-00001",
  );
  assert.equal(retried.transit.status, "invoiced");
  assert.equal(store.db.invoices.length, 1);
  assert.equal(calls.persisted, 1);
  assert.equal(
    String(retried.transit.invoiceId),
    String(store.db.invoices[0]._id),
  );
});

test("duplicate invoices: the unique sourceTransitId race resolves to the existing invoice", async () => {
  const { service, store, invoiceWriter } = setup();
  await configure(service);
  const realPersist = invoiceWriter.persist;
  invoiceWriter.persist = async (payload) => {
    await realPersist(payload); // a concurrent call wins...
    throw duplicateKey(); // ...and this one hits the unique index
  };
  const { transit } = await service.submit(
    submission(),
    transporter,
    "key-race-000001",
  );
  assert.equal(transit.status, "invoiced");
  assert.equal(store.db.invoices.length, 1);
});

test("submission: stock shortfall is refused before a transit or invoice exists", async () => {
  const { service, store, invoiceWriter } = setup();
  await configure(service);
  invoiceWriter.assertStock = async () => {
    throw Object.assign(new Error("Insufficient CRM stock"), {
      statusCode: 400,
      errors: [{ productId: PRODUCT }],
    });
  };
  await rejectsWith(
    service.submit(submission(), transporter, "key-stock-00001"),
    "STOCK_UNAVAILABLE",
  );
  assert.equal(store.db.transits.length, 0);
  const preview = await service.preview(submission());
  assert.ok(preview.warnings.some((w) => /stock/i.test(w.message)));
});

test("submission: a changed transport charge must be reviewed again", async () => {
  const { service, store } = setup();
  await configure(service);
  await rejectsWith(
    service.submit(
      submission({ expectedTransportCharge: 350 }),
      transporter,
      "key-charge-0001",
    ),
    "TRANSPORT_CHARGE_CHANGED",
  );
  assert.equal(store.db.transits.length, 0);
  const ok = await service.submit(
    submission({ expectedTransportCharge: 400 }),
    transporter,
    "key-charge-0002",
  );
  assert.equal(ok.transit.status, "invoiced");
});

// ---- Invoice sending --------------------------------------------------------------

test("invoice sending: a failure keeps the invoice; retry uses a new key and records the outcome", async () => {
  let fail = true;
  const { service, store, calls } = setup({
    deliver: () => {
      if (fail)
        throw Object.assign(new Error("template missing"), {
          code: "WHATSAPP_TEMPLATE_MISSING",
        });
      return { success: true, channel: "whatsapp" };
    },
  });
  await configure(service);
  const { transit } = await service.submit(
    submission(),
    transporter,
    "key-send-000001",
  );
  assert.equal(transit.status, "invoiced");
  assert.equal(transit.invoiceDelivery.status, "failed");
  assert.equal(
    transit.invoiceDelivery.lastErrorCode,
    "WHATSAPP_TEMPLATE_MISSING",
  );
  assert.equal(store.db.invoices.length, 1);

  fail = false;
  const retried = await service.retryInvoiceDelivery(transit.id, transporter);
  assert.equal(retried.invoiceDelivery.status, "accepted");
  assert.equal(retried.invoiceDelivery.attempts, 2);
  assert.deepEqual(calls.deliveries, [
    `transit:${transit.id}:invoice:1`,
    `transit:${transit.id}:invoice:2`,
  ]);
  await rejectsWith(
    service.retryInvoiceDelivery(transit.id, transporter),
    "DELIVERY_NOT_RETRYABLE",
  );
  await rejectsWith(
    service.retryInvoiceDelivery(transit.id, otherTransporter),
    "NOT_FOUND",
  );
});

test("invoice sending: an unconfirmed provider answer is not called sent", async () => {
  const { service } = setup({ deliver: () => ({ success: false }) });
  await configure(service);
  const { transit } = await service.submit(
    submission(),
    transporter,
    "key-unconfirmed",
  );
  assert.equal(transit.invoiceDelivery.status, "failed");
  assert.equal(transit.invoiceDelivery.lastErrorCode, "DELIVERY_NOT_CONFIRMED");
});

// ---- Payments and incentive --------------------------------------------------------------

const delivered = async (
  setupResult,
  key = "key-pay-0000001",
  body = submission(),
) => {
  await configure(setupResult.service);
  return (await setupResult.service.submit(body, transporter, key)).transit;
};

test("collections: only the delivering transporter (or an admin) can record a payment", async () => {
  const ctx = setup();
  const transit = await delivered(ctx);
  const body = {
    amount: 18500,
    method: "cash",
    collectionKey: "collect-00001",
  };
  await rejectsWith(
    ctx.service.recordCollection(transit.id, body, otherTransporter),
    "NOT_FOUND",
  );
  await rejectsWith(
    ctx.service.recordCollection(transit.id, body, reader),
    "FORBIDDEN",
  );
  const list = await ctx.service.list({}, otherTransporter);
  assert.equal(list.total, 0);
  await rejectsWith(ctx.service.get(transit.id, otherTransporter), "NOT_FOUND");
  assert.equal((await ctx.service.get(transit.id, reader)).id, transit.id);
});

test("incentive: confirmed cash by the transporter adds ₹100 once", async () => {
  const ctx = setup();
  const transit = await delivered(
    ctx,
    "key-pay-0000002",
    submission({
      items: [
        { productId: PRODUCT, quantity: 1, unitPrice: 18500 },
        { productId: PRODUCT_2, quantity: 2, unitPrice: 500 },
      ],
    }),
  );
  const first = await ctx.service.recordCollection(
    transit.id,
    { amount: 10000, method: "cash", collectionKey: "collect-cash-1" },
    transporter,
  );
  assert.equal(first.incentiveAwarded, true);
  assert.equal(first.transit.payout.cashIncentive, 100);
  assert.equal(first.transit.payout.totalPayable, 500);
  assert.equal(first.transit.customerPayment.status, "unpaid");
  assert.equal(ctx.store.db.paymentUpdates.at(-1).paidStatus, "partial");

  // Same key again: no second entry, no second incentive.
  const repeat = await ctx.service.recordCollection(
    transit.id,
    { amount: 10000, method: "cash", collectionKey: "collect-cash-1" },
    transporter,
  );
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.transit.customerPayment.collections.length, 1);

  const second = await ctx.service.recordCollection(
    transit.id,
    { amount: 9500, method: "cash", collectionKey: "collect-cash-2" },
    transporter,
  );
  assert.equal(second.incentiveAwarded, false);
  assert.equal(second.transit.payout.totalPayable, 500);
  assert.equal(second.transit.customerPayment.status, "paid");
  assert.equal(ctx.store.db.paymentUpdates.at(-1).paidStatus, "paid");
});

test("incentive: UPI, admin-recorded cash and settled payouts don't qualify", async () => {
  const upi = setup();
  const t1 = await delivered(upi, "key-pay-0000003");
  const reported = await upi.service.recordCollection(
    t1.id,
    {
      amount: 18500,
      method: "upi",
      reference: "UPI123",
      collectionKey: "collect-upi-01",
    },
    transporter,
  );
  assert.equal(reported.incentiveAwarded, false);
  // Reported UPI is not paid until verified.
  assert.equal(reported.transit.customerPayment.status, "unpaid");
  assert.equal(
    reported.transit.customerPayment.amountPendingVerification,
    18500,
  );
  await rejectsWith(
    upi.service.recordCollection(
      t1.id,
      { amount: 100, method: "upi", collectionKey: "collect-upi-02" },
      transporter,
    ),
    "VALIDATION_FAILED", // reference required
  );
  const collectionId = reported.transit.customerPayment.collections[0]._id;
  await rejectsWith(
    upi.service.reviewCollection(
      t1.id,
      collectionId,
      { decision: "verify" },
      transporter,
    ),
    "FORBIDDEN",
  );
  const verified = await upi.service.reviewCollection(
    t1.id,
    collectionId,
    { decision: "verify" },
    admin,
  );
  assert.equal(verified.customerPayment.status, "paid");
  assert.equal(verified.payout.cashIncentive, 0);

  const byAdmin = setup();
  const t2 = await delivered(byAdmin, "key-pay-0000004");
  const adminCash = await byAdmin.service.recordCollection(
    t2.id,
    { amount: 18500, method: "cash", collectionKey: "collect-adm-01" },
    admin,
  );
  assert.equal(adminCash.incentiveAwarded, false);

  const settled = setup();
  const t3 = await delivered(settled, "key-pay-0000005");
  await settled.service.settle(
    { transitIds: [t3.id], paymentReference: "NEFT-1" },
    admin,
    "settle-key-0001",
  );
  const late = await settled.service.recordCollection(
    t3.id,
    { amount: 18500, method: "cash", collectionKey: "collect-late-1" },
    transporter,
  );
  assert.equal(late.incentiveAwarded, false);
  assert.equal(late.transit.payout.totalPayable, 400);
});

test("payments: over-collection is refused; underpaid needs an admin exception to be paid", async () => {
  const ctx = setup();
  const transit = await delivered(ctx, "key-pay-0000006");
  await rejectsWith(
    ctx.service.recordCollection(
      transit.id,
      { amount: 20000, method: "cash", collectionKey: "collect-over-1" },
      transporter,
    ),
    "AMOUNT_EXCEEDS_BALANCE",
  );
  const partial = await ctx.service.recordCollection(
    transit.id,
    { amount: 18000, method: "cash", collectionKey: "collect-part-1" },
    transporter,
  );
  assert.equal(partial.transit.customerPayment.status, "unpaid");
  assert.equal(partial.transit.customerPayment.balance, 500);
  await rejectsWith(
    ctx.service.approvePaymentException(transit.id, { reason: "x" }, admin),
    "VALIDATION_FAILED",
  );
  await rejectsWith(
    ctx.service.approvePaymentException(
      transit.id,
      { reason: "Round-off discount" },
      transporter,
    ),
    "FORBIDDEN",
  );
  const excepted = await ctx.service.approvePaymentException(
    transit.id,
    { reason: "Round-off discount approved" },
    admin,
  );
  assert.equal(excepted.customerPayment.status, "paid");
  assert.equal(
    paymentSummary({
      amountDue: 100,
      collections: [{ amount: 50, verification: "rejected" }],
    }).status,
    "unpaid",
  );
});

// ---- Settlement ---------------------------------------------------------------------

test("settlement: only admins settle, never their own payouts; repeats are no-ops", async () => {
  const ctx = setup();
  const t1 = await delivered(ctx, "key-settle-0001");
  const t2 = (
    await ctx.service.submit(submission(), transporter, "key-settle-0002")
  ).transit;
  await rejectsWith(
    ctx.service.settle(
      { transitIds: [t1.id], paymentReference: "X" },
      transporter,
      "settle-key-0001",
    ),
    "FORBIDDEN",
  );
  const selfPaying = actor(TRANSPORTER, ["transit.operate", "transit.settle"]);
  await rejectsWith(
    ctx.service.settle(
      { transitIds: [t1.id], paymentReference: "NEFT-0" },
      selfPaying,
      "settle-key-0002",
    ),
    "NOTHING_TO_SETTLE",
  );
  const { batch } = await ctx.service.settle(
    { transitIds: [t1.id, t2.id], paymentReference: "NEFT-1" },
    admin,
    "settle-key-0003",
  );
  assert.equal(batch.totals.count, 2);
  assert.equal(batch.totals.totalPayable, 800);
  const replay = await ctx.service.settle(
    { transitIds: [t1.id, t2.id], paymentReference: "NEFT-1" },
    admin,
    "settle-key-0003",
  );
  assert.equal(replay.replayed, true);
  await assert.rejects(
    ctx.service.settle(
      { transitIds: [t1.id], paymentReference: "NEFT-2" },
      admin,
      "settle-key-0004",
    ),
    (error) => {
      assert.equal(error.code, "NOTHING_TO_SETTLE");
      assert.equal(error.details.skipped[0].reason, "already_settled");
      return true;
    },
  );
  const settled = await ctx.service.get(t1.id, admin);
  assert.equal(settled.payout.settlementStatus, "SETTLED");
  assert.equal(settled.payout.settlementReference, "NEFT-1");
  // Customer payment is independent of the payout.
  assert.equal(settled.customerPayment.status, "unpaid");
  const mine = await ctx.service.payoutSummary(transporter);
  assert.deepEqual(mine.settled, { count: 2, totalPayable: 800 });
});

test("settlement: concurrent batches settle each delivery exactly once", async () => {
  const ctx = setup();
  await configure(ctx.service);
  const ids = [];
  for (let i = 0; i < 4; i += 1)
    ids.push(
      (
        await ctx.service.submit(
          submission(),
          transporter,
          `key-conc-settle-${i}`,
        )
      ).transit.id,
    );
  const admin2 = actor("a0000000000000000000000a", ["transit.settle"]);
  const results = await Promise.allSettled([
    ctx.service.settle(
      { transitIds: ids, paymentReference: "NEFT-A" },
      admin,
      "settle-conc-a1",
    ),
    ctx.service.settle(
      { transitIds: ids, paymentReference: "NEFT-B" },
      admin2,
      "settle-conc-b1",
    ),
  ]);
  const settledCount = results
    .filter((r) => r.status === "fulfilled")
    .reduce((sum, r) => sum + r.value.batch.totals.count, 0);
  assert.equal(settledCount, 4);
  const batchIds = new Set(
    ctx.store.db.transits.map((t) => String(t.payout.settlementBatchId)),
  );
  assert.equal(
    ctx.store.db.transits.every((t) => t.payout.settlementStatus === "SETTLED"),
    true,
  );
  assert.ok(batchIds.size >= 1);
});

// ---- Immutable snapshots ------------------------------------------------------------

test("snapshots: delivery coordinates, distance and price can't be edited directly", async () => {
  assert.throws(
    () => assertSnapshotUntouched({ $set: { "delivery.destination.lat": 1 } }),
    (e) => e.code === "TRANSIT_SNAPSHOT_IMMUTABLE",
  );
  assert.throws(
    () => assertSnapshotUntouched({ "pricing.baseCharge": 1 }),
    /cannot be edited/,
  );
  assert.throws(
    () => assertSnapshotUntouched({ $set: { delivery: {} } }),
    /cannot be edited/,
  );
  assert.doesNotThrow(() =>
    assertSnapshotUntouched({ $set: { status: "invoiced" } }),
  );
  assert.doesNotThrow(() =>
    assertSnapshotUntouched(
      { $set: { delivery: {} } },
      { transitCorrection: true },
    ),
  );

  // The CRM invoice edit form sends the invoice back: transit fields are dropped.
  const update = stripTransitOwnedFields({
    customerDetails: { name: "Ramesh" },
    transitDelivery: { distanceKm: 1 },
    $set: { "transitDelivery.destination.lat": 1, paidStatus: "paid" },
    sourceTransitId: "x",
  });
  assert.deepEqual(update, {
    customerDetails: { name: "Ramesh" },
    $set: { paidStatus: "paid" },
  });
});

test("corrections: an audited correction re-routes from the original warehouse and keeps the before/after", async () => {
  const ctx = setup();
  const transit = await delivered(ctx, "key-correct-001");
  // The warehouse moves later; the correction still uses the original one.
  await ctx.service.setWarehouse(
    { name: "New", address: "Elsewhere", lat: 17.3, lng: 78.5 },
    admin,
  );
  ctx.calls.route = 0;
  await rejectsWith(
    ctx.service.correctDelivery(
      transit.id,
      { reason: "Wrong pin", destination: { lat: 17.5, lng: 78.3 } },
      transporter,
    ),
    "FORBIDDEN",
  );
  const corrected = await ctx.service.correctDelivery(
    transit.id,
    {
      reason: "Customer gave the wrong lane",
      destination: { lat: 17.5, lng: 78.3 },
    },
    admin,
  );
  assert.equal(corrected.delivery.warehouse.lat, 17.49);
  assert.equal(corrected.delivery.destination.source, "pinned");
  assert.equal(corrected.corrections.length, 1);
  assert.equal(corrected.corrections[0].before.delivery.destination.lat, 17.46);
  assert.notEqual(corrected.snapshotHash, transit.snapshotHash);
  assert.equal(ctx.store.db.invoiceCorrections.length, 1);
  assert.equal(
    ctx.store.db.invoiceCorrections[0].transitDelivery.snapshotHash,
    corrected.snapshotHash,
  );

  await ctx.service.settle(
    { transitIds: [transit.id], paymentReference: "NEFT-9" },
    admin,
    "settle-key-corr1",
  );
  await rejectsWith(
    ctx.service.correctDelivery(
      transit.id,
      { reason: "Too late now", destination: { lat: 17.5, lng: 78.3 } },
      admin,
    ),
    "NOT_CORRECTABLE",
  );
  await rejectsWith(
    ctx.service.cancel(transit.id, { reason: "Duplicate entry" }, admin),
    "NOT_CANCELLABLE",
  );
});

test("cancellation: cancelled deliveries leave settlement and reports", async () => {
  const ctx = setup();
  const transit = await delivered(ctx, "key-cancel-0001");
  const keep = (
    await ctx.service.submit(submission(), transporter, "key-cancel-0002")
  ).transit;
  await ctx.service.cancel(
    transit.id,
    { reason: "Customer refused delivery" },
    admin,
  );
  await rejectsWith(
    ctx.service.recordCollection(
      transit.id,
      { amount: 1, method: "cash", collectionKey: "collect-cancel" },
      transporter,
    ),
    "NOT_COLLECTIBLE",
  );
  const report = await ctx.service.report({});
  assert.equal(report.cancelled, 1);
  assert.equal(report.totals.deliveries, 1);
  assert.equal(report.totals.revenue, 18500);
  assert.equal(report.totals.transportPayable, 400);
  assert.equal(report.totals.contributionAfterTransport, 18100);
  assert.equal(report.byTransporter[0].transporterId, TRANSPORTER);
  assert.ok(keep.id);
});

// ---- Comparison ------------------------------------------------------------------

test("comparison: internal price, admin benchmarks and missing live quotes are labelled", async () => {
  const ctx = setup();
  await configure(ctx.service);
  await ctx.service.createBenchmark(
    {
      provider: "porter",
      vehicleType: "Tata Ace",
      baseFare: 250,
      includedKm: 2,
      perKm: 20,
      minimumFare: 300,
      observedAt: "2026-11-20",
      sourceNote: "Porter website fare estimate",
    },
    admin,
  );
  await rejectsWith(
    ctx.service.createBenchmark({ provider: "uber", vehicleType: "x" }, admin),
    "VALIDATION_FAILED",
  );
  const result = await ctx.service.compare({ distanceKm: 12.4 }, admin);
  assert.equal(result.informationalOnly, true);
  const [internal, porter] = result.rows;
  assert.deepEqual([internal.kind, internal.amount], ["internal", 400]);
  assert.deepEqual([porter.kind, porter.amount], ["manual_benchmark", 458]);
  assert.equal(porter.differenceFromInternal, 58);
  const live = result.rows.filter((r) => r.kind === "live_quote");
  assert.deepEqual(
    live.map((r) => [r.provider, r.available]),
    [
      ["porter", false],
      ["rapido", false],
    ],
  );
  assert.equal(
    benchmarkFare(
      { baseFare: 50, perKm: 5, minimumFare: 120 },
      { distanceKm: 3 },
    ),
    120,
  );
});

// ---- Existing invoice compatibility -------------------------------------------------

test("existing invoices: transit payloads pass the CRM invoice validation unchanged", async () => {
  const ctx = setup();
  await delivered(ctx, "key-compat-0001");
  const [invoice] = ctx.store.db.invoices;
  assert.equal(validateInvoicePayload(invoice).isValid, true);
  assert.equal(invoice.gst, false);
  assert.equal(invoice.products[0].productQuantity, 1);
  assert.equal(invoice.customerDetails.phone, 9876543210);
  // An invoice without transit fields is unaffected by the strip.
  const plain = {
    customerDetails: { name: "A", phone: 9876543210 },
    products: [],
  };
  assert.deepEqual(stripTransitOwnedFields({ ...plain }), plain);
});

// ---- Route authorization ------------------------------------------------------------

test("routes: permissions are enforced by the backend", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "transit-test-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const users = {
    [TRANSPORTER]: {
      _id: TRANSPORTER,
      role: 3,
      status: "active",
      roleRef: {
        slug: "transporter",
        isActive: true,
        permissions: ["transit.operate"],
      },
    },
    [ADMIN]: {
      _id: ADMIN,
      role: 3,
      status: "active",
      roleRef: { slug: "ops", isActive: true, permissions: ["transit.read"] },
    },
  };
  t.mock.method(AquaAdminUser, "findById", (id) => ({
    populate: async () => users[String(id)] || null,
  }));
  const app = express();
  app.use(express.json());
  app.use("/v1/crm/transit", transitRoutes);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1/crm/transit`;
  const call = (path, userId, method = "GET", body) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(userId
          ? {
              Authorization: `Bearer ${jwt.sign({ _id: userId }, process.env.JWT_SECRET)}`,
            }
          : {}),
      },
      body: body && JSON.stringify(body),
    });

  assert.equal((await call("/transits", null)).status, 401);
  // Transporters can't touch pricing, warehouse, settlement or reports.
  assert.equal(
    (await call("/pricing", TRANSPORTER, "POST", RATE_CARD)).status,
    403,
  );
  assert.equal((await call("/warehouse", TRANSPORTER, "PUT", {})).status, 403);
  assert.equal(
    (await call("/settlements", TRANSPORTER, "POST", {})).status,
    403,
  );
  assert.equal((await call("/reports/summary", TRANSPORTER)).status, 403);
  assert.equal(
    (await call("/transits/abc/corrections", TRANSPORTER, "POST", {})).status,
    403,
  );
  // A read-only admin can't submit deliveries or change pricing.
  assert.equal((await call("/transits", ADMIN, "POST", {})).status, 403);
  assert.equal((await call("/pricing", ADMIN, "POST", RATE_CARD)).status, 403);
  // Validation runs only after authorization.
  const parse = await call("/parse", TRANSPORTER, "POST", { text: "" });
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).code, "VALIDATION_FAILED");
});

test("permissions: transit permissions are known to the role editor", () => {
  for (const permission of [
    "transit.operate",
    "transit.read",
    "transit.manage",
    "transit.settle",
  ])
    assert.ok(PERMISSIONS.includes(permission), permission);
});
