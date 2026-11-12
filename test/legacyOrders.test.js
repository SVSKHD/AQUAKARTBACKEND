import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import orderRoutes from "../src/routes/orders.js";
import AquaOrder from "../src/models/orders.js";
import AquaProduct from "../src/models/product.js";
import AquaEcomUser from "../src/models/user.js";
import AquaAdminUser from "../src/models/crm/adminUser.js";
import CrmNotification from "../src/models/crm/notification.js";
import { paymentStatusFor } from "../src/controllers/phonepeGateway.js";

// Legacy storefront order routes (/v1/order/*, /v1/orders/user/:id,
// /v1/phonepe-verify/:id): login, ownership, field allowlists and
// server-side prices. Every model, PhonePe, WhatsApp and the CRM
// notification store are mocked: no network, no database, no messages.

const ALICE = "64b00000000000000000a11c";
const BOB = "64b00000000000000000b0b0";
const ADMIN = "64b0000000000000000000aa";
const ORDER_ID = "64b0000000000000000000d1";
const PRODUCT_ID = "64b0000000000000000000f1";

const users = {
  [ALICE]: { _id: ALICE, name: "Alice" }, // no phone/email: no messages
  [BOB]: { _id: BOB, name: "Bob" },
};
const admins = { [ADMIN]: { _id: ADMIN, role: 1, status: "active" } };

// findById(...) is both awaited directly and chained with .populate().
const query = (doc) => {
  const promise = Promise.resolve(doc ?? null);
  promise.populate = async () => doc ?? null;
  return promise;
};

const startApp = async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-orders";
  const app = express();
  app.use(express.json());
  app.use("/v1", orderRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  t.mock.method(AquaEcomUser, "findById", (id) => query(users[String(id)]));
  t.mock.method(AquaAdminUser, "findById", (id) => query(admins[String(id)]));
  t.mock.method(CrmNotification, "create", async (doc) => doc);
  t.mock.method(AquaProduct, "find", () => ({
    lean: async () => [
      {
        _id: PRODUCT_ID,
        title: "Softener",
        price: 30000,
        discountPrice: 24999,
        discountPriceStatus: true,
        stock: 10,
      },
    ],
  }));
  const outbound = [];
  for (const method of ["get", "post", "request"])
    t.mock.method(axios, method, async (...args) => {
      outbound.push({ method, args });
      throw new Error(`unexpected outbound ${method}`);
    });

  const orders = new Map();
  const order = {
    _id: ORDER_ID,
    user: ALICE,
    orderStatus: "Processing",
    paymentStatus: "Pending",
    totalAmount: 25349,
    transactionId: "AQTR-TEST-1",
  };
  orders.set(ORDER_ID, order);
  t.mock.method(
    AquaOrder,
    "findById",
    async (id) => orders.get(String(id)) || null,
  );
  const updates = [];
  t.mock.method(AquaOrder, "findOneAndUpdate", async (filter, update) => {
    updates.push({ filter, update });
    const current = [...orders.values()].find(
      (o) => String(o._id) === String(filter._id),
    );
    if (!current) return null;
    if (filter.user && String(current.user) !== String(filter.user))
      return null;
    if (
      filter.orderStatus?.$in &&
      !filter.orderStatus.$in.includes(current.orderStatus)
    )
      return null;
    if (
      filter.paymentStatus?.$ne &&
      current.paymentStatus === filter.paymentStatus.$ne
    )
      return null;
    Object.assign(current, update.$set || update);
    return current;
  });
  const saved = [];
  t.mock.method(AquaOrder.prototype, "save", async function save() {
    saved.push(this.toObject());
    return this;
  });

  const tokenFor = (id) => jwt.sign({ _id: id }, process.env.JWT_SECRET);
  const call = (method, path, { as, body } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/${path}`, {
      method,
      headers: {
        ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, order, updates, saved, outbound };
};

test("GET /order/:id: login required; owner or admin only", async (t) => {
  const { call } = await startApp(t);
  assert.equal((await call("GET", `order/${ORDER_ID}`)).status, 401);
  assert.equal(
    (await call("GET", `order/${ORDER_ID}`, { as: BOB })).status,
    404,
  );
  const own = await call("GET", `order/${ORDER_ID}`, { as: ALICE });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).data._id, ORDER_ID);
  assert.equal(
    (await call("GET", `order/${ORDER_ID}`, { as: ADMIN })).status,
    200,
  );
  assert.equal(
    (await call("GET", "order/not-an-id", { as: ALICE })).status,
    400,
  );
});

test("GET /orders/user/:id and /order/transaction-id/:id only return the caller's orders", async (t) => {
  const { call } = await startApp(t);
  const filters = [];
  t.mock.method(AquaOrder, "find", async (filter) => {
    filters.push(filter);
    return [];
  });
  t.mock.method(AquaOrder, "findOne", async (filter) => {
    filters.push(filter);
    return null;
  });
  assert.equal(
    (await call("GET", `orders/user/${ALICE}`, { as: BOB })).status,
    403,
  );
  assert.equal(
    (await call("GET", `orders/user/${ALICE}`, { as: ALICE })).status,
    200,
  );
  await call("GET", "order/transaction-id/AQTR-TEST-1", { as: BOB });
  assert.deepEqual(
    filters.map((f) => String(f.user)),
    [ALICE, BOB],
  );
});

test("PUT /order/user/:id: own order only; payment/total fields ignored; cancel and delivery details allowed", async (t) => {
  const { call, order, updates } = await startApp(t);
  // Another customer's order looks missing.
  assert.equal(
    (
      await call("PUT", `order/user/${ORDER_ID}`, {
        as: BOB,
        body: { notes: "x" },
      })
    ).status,
    404,
  );
  // Only blocked fields: nothing to update.
  const blocked = await call("PUT", `order/user/${ORDER_ID}`, {
    as: ALICE,
    body: { paymentStatus: "Paid", totalAmount: 1, refundStatus: "Completed" },
  });
  assert.equal(blocked.status, 400);
  assert.equal(updates.length, 0);
  // Mixed: allowed fields applied, blocked ones dropped.
  const mixed = await call("PUT", `order/user/${ORDER_ID}`, {
    as: ALICE,
    body: {
      paymentStatus: "Paid",
      totalAmount: 1,
      notes: "Call before delivery",
      shippingAddress: { street: "1 Road", city: "Hyderabad", $where: "x" },
      installation: { day: "2026-11-20", slot: "12 pm – 3 pm" },
    },
  });
  assert.equal(mixed.status, 200);
  const set = updates.at(-1).update.$set;
  assert.deepEqual(Object.keys(set).sort(), [
    "installation",
    "notes",
    "shippingAddress",
  ]);
  assert.deepEqual(set.shippingAddress, {
    street: "1 Road",
    city: "Hyderabad",
  });
  assert.equal(order.paymentStatus, "Pending");
  assert.equal(order.totalAmount, 25349);
  // Cancel.
  const cancel = await call("PUT", `order/user/${ORDER_ID}`, {
    as: ALICE,
    body: { orderStatus: "Cancelled" },
  });
  assert.equal(cancel.status, 200);
  assert.equal(order.orderStatus, "Cancelled");
  assert.equal(order.orderCancelled, true);
  // A cancelled (or shipped) order can't be changed any more.
  assert.equal(
    (
      await call("PUT", `order/user/${ORDER_ID}`, {
        as: ALICE,
        body: { notes: "y" },
      })
    ).status,
    409,
  );
});

test("POST /order/cod: login required; user from the token; prices and totals from the server", async (t) => {
  const { call, saved } = await startApp(t);
  const body = {
    user: ALICE,
    items: [{ productId: PRODUCT_ID, name: "Softener", price: 1, quantity: 2 }],
    totalAmount: 1,
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    discounts: 99999,
    shippingAddress: { street: "1 Road", city: "Hyderabad" },
  };
  assert.equal((await call("POST", "order/cod", { body })).status, 401);
  assert.equal(
    (await call("POST", "order/cod", { as: BOB, body })).status,
    403,
  );
  const response = await call("POST", "order/cod", { as: ALICE, body });
  assert.equal(response.status, 201);
  const order = saved.at(-1);
  assert.equal(String(order.user), ALICE);
  assert.equal(order.items[0].price, 24999, "discounted catalogue price");
  assert.equal(order.items[0].quantity, 2);
  // 2 x 24999 + 350 delivery (default; under the free-delivery threshold).
  assert.equal(order.totalAmount, 49998 + 350);
  assert.equal(order.paymentStatus, "Pending");
  assert.equal(order.orderStatus, "Processing");
  assert.equal(order.discounts, 0);
  assert.equal(order.orderType, "Cash On Delivery");
  // Bad cart is the client's error, not a 500.
  const bad = await call("POST", "order/cod", {
    as: ALICE,
    body: { items: [] },
  });
  assert.equal(bad.status, 400);
});

test("POST /order/pay: login required; PhonePe is asked for the server total", async (t) => {
  const { call, saved, outbound } = await startApp(t);
  t.mock.method(AquaOrder, "exists", async () => null);
  t.mock.method(axios, "request", async (options) => {
    outbound.push({ method: "phonepe-pay", options });
    return {
      data: {
        data: { instrumentResponse: { redirectInfo: { url: "https://pay" } } },
      },
    };
  });
  const body = {
    transactionId: "AQTR-PAY-12345",
    items: [{ productId: PRODUCT_ID, quantity: 1 }],
    totalAmount: 1,
  };
  assert.equal((await call("POST", "order/pay", { body })).status, 401);
  const bad = await call("POST", "order/pay", {
    as: ALICE,
    body: { ...body, transactionId: "../../x" },
  });
  assert.equal(bad.status, 400);
  const response = await call("POST", "order/pay", { as: ALICE, body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "https://pay" });
  assert.equal(saved.at(-1).totalAmount, 24999 + 350);
  const sent = outbound.find((o) => o.method === "phonepe-pay");
  const payload = JSON.parse(
    Buffer.from(sent.options.data.request, "base64").toString(),
  );
  assert.equal(
    payload.amount,
    (24999 + 350) * 100,
    "paise from the server total",
  );
  assert.equal(payload.merchantUserId, ALICE);
  t.mock.method(AquaOrder, "exists", async () => ({ _id: "other" }));
  assert.equal(
    (await call("POST", "order/pay", { as: ALICE, body })).status,
    409,
  );
});

test("PhonePe status: Paid only when the collected amount matches the order total", () => {
  const order = { totalAmount: 25349 };
  const success = (amount) => ({ code: "PAYMENT_SUCCESS", data: { amount } });
  assert.equal(paymentStatusFor(success(2534900), order), "Paid");
  assert.equal(paymentStatusFor(success(100), order), "Processing");
  assert.equal(paymentStatusFor({ code: "PAYMENT_PENDING" }, order), "Pending");
  assert.equal(paymentStatusFor({ code: "PAYMENT_ERROR" }, order), "Failed");
  assert.equal(paymentStatusFor({ code: "SOMETHING_NEW" }, order), null);
});

test("POST /phonepe-verify/:id: an underpaid 'success' is not Paid; a paid order is never re-processed", async (t) => {
  const { call, order } = await startApp(t);
  t.mock.method(AquaOrder, "findOne", async ({ transactionId }) =>
    transactionId === order.transactionId ? order : null,
  );
  let phonepe = { code: "PAYMENT_SUCCESS", data: { amount: 100 } };
  let statusCalls = 0;
  t.mock.method(axios, "get", async () => {
    statusCalls += 1;
    return { data: phonepe };
  });
  assert.equal((await call("POST", "phonepe-verify/bad id!")).status, 400);
  assert.equal((await call("POST", "phonepe-verify/AQTR-UNKNOWN")).status, 404);

  const underpaid = await call("POST", `phonepe-verify/${order.transactionId}`);
  assert.equal(underpaid.status, 200);
  assert.equal(order.paymentStatus, "Processing");
  assert.equal(order.orderType, "Payment Method(Phone Pe Gateway)");

  phonepe = { code: "PAYMENT_SUCCESS", data: { amount: 2534900 } };
  await call("POST", `phonepe-verify/${order.transactionId}`);
  assert.equal(order.paymentStatus, "Paid");

  // Already paid: PhonePe is not asked again and nothing changes.
  const callsBefore = statusCalls;
  phonepe = { code: "PAYMENT_ERROR", data: {} };
  const again = await call("POST", `phonepe-verify/${order.transactionId}`);
  assert.equal(again.status, 200);
  assert.equal(order.paymentStatus, "Paid");
  assert.equal(statusCalls, callsBefore);
});
