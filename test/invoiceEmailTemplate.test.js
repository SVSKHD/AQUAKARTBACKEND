import assert from "node:assert/strict";
import test from "node:test";
import invoiceAccessEmail from "../src/utils/emailTemplates/invoiceAccessEmail.js";

test("renders branded invoice delivery details and security guidance", () => {
  const template = invoiceAccessEmail({
    customerName: "Aqua Customer",
    invoiceCount: 1,
    invoiceNo: "AQ-1001",
    invoiceDate: "02 August 2026",
    invoiceTotal: "₹25,000",
    accessUrl: "https://aquakart.co.in/invoice/access?token=opaque",
  });

  assert.match(template.subject, /AQ-1001/);
  assert.match(template.html, /Aquakart/);
  assert.match(template.html, /02 August 2026/);
  assert.match(template.html, /₹25,000/);
  assert.match(template.html, /View secure invoice/);
  assert.match(template.html, /did not request/i);
  assert.match(template.text, /opaque/);
});

test("escapes customer-controlled invoice fields", () => {
  const template = invoiceAccessEmail({
    customerName: "<script>alert(1)</script>",
    invoiceCount: 1,
    invoiceNo: "<img src=x onerror=alert(1)>",
    accessUrl: "https://aquakart.co.in/invoice/access?token=safe",
  });

  assert.doesNotMatch(template.html, /<script>/);
  assert.doesNotMatch(template.html, /<img src=x/);
  assert.match(template.html, /&lt;script&gt;/);
});
