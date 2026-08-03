import assert from "node:assert/strict";
import test from "node:test";

import { buildInvoiceViewLinks } from "../src/utils/invoiceViews.js";

test("builds separate admin and customer invoice destinations from one id", () => {
  assert.deepEqual(buildInvoiceViewLinks("6a6ff135aafb698d0de9966b"), {
    invoiceId: "6a6ff135aafb698d0de9966b",
    adminUrl:
      "https://admin.aquakart.co.in/admin/invoice/6a6ff135aafb698d0de9966b",
    customerUrl: "https://aquakart.co.in/invoice/6a6ff135aafb698d0de9966b",
  });
});
