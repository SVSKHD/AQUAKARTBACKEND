import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createInvoiceReportRouter } from "../src/routes/invoiceReports.js";

test("public report downloads XLSX without credentials and handles errors", async () => {
  let records = [{ _id: "abc", invoiceNo: "INV-1", date: "2026-08-01", products: [{ productName: "Filter", productPrice: 1180, productQuantity: 1 }] }];
  let calls = 0;
  let fail = false;
  const Invoice = { find(query) {
    calls++;
    assert.equal(query.$or[0].date.$regex, "^2026-08-");
    return { select() { return this; }, sort() { return this; }, async lean() {
      if (fail) throw new Error("Test database failure");
      return records;
    } };
  } };
  const app = express();
  app.use("/reports", createInvoiceReportRouter(Invoice));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/reports`;
  try {
    const response = await fetch(`${url}/august`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /spreadsheetml/);
    assert.match(response.headers.get("content-disposition"), /Aquakart_Invoices_2026-08.xlsx/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
    assert.ok(buffer.length > 1000);
    assert.equal((await fetch(`${url}/13/2026`)).status, 400);
    assert.equal(calls, 1);
    records = [];
    assert.equal((await fetch(`${url}/8/2026`)).status, 404);
    fail = true;
    assert.equal((await fetch(`${url}/8/2026`)).status, 500);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
