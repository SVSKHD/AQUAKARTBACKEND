import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInvoiceAutomationEligibilityFilter,
  isInvoiceAutomationEligible,
} from "../src/utils/invoiceAutomation.js";

test("current invoices remain automation eligible", () => {
  assert.equal(isInvoiceAutomationEligible({ migrated: false }), true);
  assert.equal(isInvoiceAutomationEligible({}), true);
});

test("migrated invoices require review before automations", () => {
  assert.equal(
    isInvoiceAutomationEligible({ migrated: true, migrationReviewed: false }),
    false,
  );
  assert.equal(
    isInvoiceAutomationEligible({ migrated: true, migrationReviewed: true }),
    true,
  );
});

test("automation query includes current and reviewed migrated invoices", () => {
  assert.deepEqual(buildInvoiceAutomationEligibilityFilter(), {
    $or: [
      { migrated: { $ne: true } },
      { migrated: true, migrationReviewed: true },
    ],
  });
});
