import test from "node:test";
import assert from "node:assert/strict";
import {
  getAnnualDueDates,
  getNextDueDate,
  getWarrantyDates,
  parseInvoicePurchaseDate,
  resolveRegenerationPolicy,
} from "../src/services/serviceReminders.js";

test("maps the requested Aquakart products to their regeneration cadence", () => {
  assert.equal(resolveRegenerationPolicy({}, { productName: "Auto 25" }).intervalUnit, "month");
  assert.equal(resolveRegenerationPolicy({}, { productName: "Auto 40" }).intervalUnit, "month");
  assert.equal(resolveRegenerationPolicy({}, { productName: "Auto 100L" }).intervalUnit, "month");
  assert.equal(resolveRegenerationPolicy({}, { productName: "Auto Sand Filter" }).intervalUnit, "month");
  assert.equal(resolveRegenerationPolicy({}, { productName: "Bathroom Water Softener" }).intervalUnit, "week");
});

test("warranty expires after 12 months and warns 30 days before", () => {
  const purchase = new Date("2026-01-15T00:00:00.000Z");
  const warranty = getWarrantyDates(purchase, 12);
  assert.equal(warranty.expiresAt.toISOString(), "2027-01-15T00:00:00.000Z");
  assert.equal(warranty.reminderAt.toISOString(), "2026-12-16T00:00:00.000Z");
});

test("product configuration takes precedence over the legacy name mapping", () => {
  const policy = resolveRegenerationPolicy({
    title: "Auto 25",
    reminderPolicy: {
      regeneration: { enabled: true, intervalUnit: "week", intervalValue: 2 },
    },
  });
  assert.deepEqual(policy, { intervalUnit: "week", intervalValue: 2 });
});

test("uses invoice date as the schedule anchor", () => {
  const purchase = parseInvoicePurchaseDate({ date: "15/08/2025" });
  const now = new Date("2026-09-01T00:00:00.000Z");
  assert.equal(getNextDueDate(purchase, "month", 1, now).toISOString(), "2026-09-15T00:00:00.000Z");
  assert.equal(getAnnualDueDates(purchase, now).next.toISOString(), "2027-08-15T00:00:00.000Z");
});
