import assert from "node:assert/strict";
import test from "node:test";
import requireInvoiceAccess from "../src/middleware/invoiceAccess.js";
import { signInvoiceAccessToken } from "../src/utils/invoiceAccess.js";

const responseRecorder = () => {
  const response = { statusCode: 200, body: null };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
};

test("rejects a missing invoice-access token", () => {
  const req = { headers: {} };
  const res = responseRecorder();
  let nextCalled = false;
  requireInvoiceAccess(req, res, () => {
    nextCalled = true;
  });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("rejects an invalid invoice-access token without sensitive details", () => {
  process.env.INVOICE_ACCESS_SECRET = "middleware-test-secret";
  const req = { headers: { authorization: "Bearer invalid-token" } };
  const res = responseRecorder();
  requireInvoiceAccess(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, "Invoice access has expired or is invalid");
  assert.equal(JSON.stringify(res.body).includes("invalid-token"), false);
});

test("accepts a valid invoice-scoped token", () => {
  process.env.INVOICE_ACCESS_SECRET = "middleware-test-secret";
  process.env.INVOICE_ACCESS_SESSION_EXPIRY = "30m";
  const token = signInvoiceAccessToken({
    invoiceIds: ["507f1f77bcf86cd799439011"],
    email: "customer@example.com",
    firebaseUid: "firebase-customer-1",
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = responseRecorder();
  let nextCalled = false;
  requireInvoiceAccess(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.invoiceAccess.firebaseUid, "firebase-customer-1");
});

test("rejects an expired invoice-access token", async () => {
  process.env.INVOICE_ACCESS_SECRET = "middleware-test-secret";
  process.env.INVOICE_ACCESS_SESSION_EXPIRY = "1ms";
  const token = signInvoiceAccessToken({
    invoiceIds: ["507f1f77bcf86cd799439011"],
    email: "customer@example.com",
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = responseRecorder();
  requireInvoiceAccess(req, res, () => {});
  assert.equal(res.statusCode, 401);
});
