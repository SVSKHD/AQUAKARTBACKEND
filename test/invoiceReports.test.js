import test from "node:test";
import assert from "node:assert/strict";
import { parseReportPeriod, reportQuery, buildReportSheets } from "../src/services/invoiceReports.js";

test("months default to 2026 and accept names, padded numbers and explicit years", () => {
  assert.equal(parseReportPeriod("August").prefix, "2026-08");
  assert.equal(parseReportPeriod("08", "2025").label, "August 2025");
  for (const month of ["0", "13", "1x", "", "$ne"]) assert.equal(parseReportPeriod(month), null);
  for (const year of ["26", "2026x", "0", ""]) assert.equal(parseReportPeriod("8", year), null);
});

test("date filtering uses invoice month with IST fallback and exclusive year boundary", () => {
  const query = reportQuery(parseReportPeriod("december", "2025"));
  assert.equal(query.$or[0].date.$regex, "^2025-12-");
  assert.equal(query.$or[1].createdAt.$gte.toISOString(), "2025-11-30T18:30:00.000Z");
  assert.equal(query.$or[1].createdAt.$lt.toISOString(), "2025-12-31T18:30:00.000Z");
});

test("report matches CRM columns and totals, preserving identifiers as literal text", () => {
  const sheets = buildReportSheets([{ _id: "abc", invoiceNo: "=1+1", date: "2026-08-01", customerDetails: { phone: "001234" }, products: [{ productName: "Filter", productPrice: 1180.50, productQuantity: 3 }] }]);
  assert.equal(sheets[0].data[0].length, 17);
  assert.equal(sheets[0].data[1][0].type, String);
  assert.equal(sheets[0].data[1][3].value, "001234");
  assert.equal(sheets[0].data[1][14].value, 1180.50);
  assert.equal(sheets[1].data[1][2].value, 3);
  assert.equal(buildReportSheets([])[0].data.length, 1);
});
