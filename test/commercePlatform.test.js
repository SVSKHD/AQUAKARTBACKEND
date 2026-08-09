import test from "node:test";
import assert from "node:assert/strict";
import { calculateCouponDiscount } from "../src/services/coupons.js";
import { staffHasPermission } from "../src/middleware/permissions.js";

test("caps percentage coupon at its maximum discount", () => {
  const discount = calculateCouponDiscount(
    { discountType: "percentage", discountValue: 20, maxDiscount: 150 },
    1000,
  );
  assert.equal(discount, 150);
});

test("never discounts more than the subtotal", () => {
  const discount = calculateCouponDiscount(
    { discountType: "fixed", discountValue: 500, maxDiscount: null },
    200,
  );
  assert.equal(discount, 200);
});

test("supports legacy numeric administrators during role migration", () => {
  assert.equal(staffHasPermission({ role: 1 }, "payments.reconcile"), true);
});

test("checks named role permissions", () => {
  const staff = {
    role: 3,
    directPermissions: [],
    roleRef: {
      slug: "invoice-manager",
      isActive: true,
      permissions: ["invoices.read"],
    },
  };
  assert.equal(staffHasPermission(staff, "invoices.read"), true);
  assert.equal(staffHasPermission(staff, "roles.manage"), false);
});
