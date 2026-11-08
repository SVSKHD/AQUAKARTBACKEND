import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryChargeFor,
  installationFrom,
} from "../src/services/checkout.js";

test("keeps a well-formed installation slot from checkout", () => {
  assert.deepEqual(
    installationFrom({ day: "2026-10-30", slot: " 12 pm – 3 pm " }),
    { day: "2026-10-30", slot: "12 pm – 3 pm" },
  );
});

test("drops a missing or malformed slot instead of failing the order", () => {
  assert.equal(installationFrom(undefined), undefined);
  assert.equal(
    installationFrom({ day: "30/10/2026", slot: "9 am" }),
    undefined,
  );
  assert.equal(installationFrom({ day: "2026-10-30", slot: "" }), undefined);
});

test("delivery is a flat ₹350 per order, free above ₹50,000 after the coupon", () => {
  const env = {};
  // One product or many: one flat charge.
  assert.equal(deliveryChargeFor({ subtotal: 20000 }, env), 350);
  assert.equal(deliveryChargeFor({ subtotal: 26000, discount: 0 }, env), 350);
  // Exactly ₹50,000 still pays; above it is free.
  assert.equal(deliveryChargeFor({ subtotal: 50000 }, env), 350);
  assert.equal(deliveryChargeFor({ subtotal: 50000.01 }, env), 0);
  assert.equal(deliveryChargeFor({ subtotal: 60000 }, env), 0);
  // The coupon counts: ₹52,000 - ₹3,000 = ₹49,000 pays delivery.
  assert.equal(
    deliveryChargeFor({ subtotal: 52000, discount: 3000 }, env),
    350,
  );
});

test("delivery amounts are configurable and ignore invalid values", () => {
  assert.equal(
    deliveryChargeFor(
      { subtotal: 30000 },
      { STANDARD_DELIVERY_CHARGE: "499", FREE_DELIVERY_ABOVE: "25000" },
    ),
    0,
  );
  assert.equal(
    deliveryChargeFor({ subtotal: 1000 }, { STANDARD_DELIVERY_CHARGE: "0" }),
    0,
  );
  assert.equal(
    deliveryChargeFor(
      { subtotal: 1000 },
      { STANDARD_DELIVERY_CHARGE: "abc", FREE_DELIVERY_ABOVE: "-5" },
    ),
    350,
  );
});
