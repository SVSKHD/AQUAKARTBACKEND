import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailDeliveryDedupeKey,
  buildDirectInvoiceEmailFields,
  buildInvoiceEmailAudit,
  calculateInvoiceTotal,
  getInvoiceOwnershipState,
  hashToken,
  isDirectInvoiceAccessAllowed,
  maskEmail,
  normalizeEmail,
  normalizeIndianPhone,
  signInvoiceAccessToken,
  validateEmail,
  verifyInvoiceAccessToken,
} from "../src/utils/invoiceAccess.js";

test("normalizes supported Indian phone formats", () => {
  assert.equal(normalizeIndianPhone("+91 98765-43210"), "9876543210");
  assert.equal(normalizeIndianPhone("919876543210"), "9876543210");
  assert.equal(normalizeIndianPhone("12345"), "");
});

test("normalizes and masks customer email", () => {
  assert.equal(
    normalizeEmail(" Customer@Example.COM "),
    "customer@example.com",
  );
  assert.equal(maskEmail("customer@example.com"), "cu******@e***.com");
  assert.equal(maskEmail("invalid"), "");
  assert.equal(validateEmail(" Customer@Example.COM "), "customer@example.com");
  assert.equal(
    validateEmail("victim@example.com\r\nBcc: attacker@example.com"),
    "",
  );
  assert.equal(validateEmail("not-an-email"), "");
});

test("hashes opaque tokens without retaining the input", () => {
  const hash = hashToken("secret-token");
  assert.equal(hash.length, 64);
  assert.notEqual(hash, "secret-token");
});

test("signs invoice-scoped access tokens", () => {
  process.env.INVOICE_ACCESS_SECRET =
    "test-invoice-secret-with-sufficient-length";
  const token = signInvoiceAccessToken({
    invoiceIds: ["507f1f77bcf86cd799439011"],
    email: "customer@example.com",
    firebaseUid: "firebase-customer-1",
  });
  const payload = verifyInvoiceAccessToken(token);
  assert.equal(payload.purpose, "invoice-access");
  assert.deepEqual(payload.invoiceIds, ["507f1f77bcf86cd799439011"]);
  assert.equal(payload.firebaseUid, "firebase-customer-1");
  assert.equal(payload.grant, "owner");
});

test("supports invoice-delivery grants without changing ownership", () => {
  process.env.INVOICE_ACCESS_SECRET =
    "test-invoice-secret-with-sufficient-length";
  const token = signInvoiceAccessToken({
    invoiceIds: ["507f1f77bcf86cd799439011"],
    email: "delivery@example.com",
    grant: "delivery",
  });
  assert.equal(verifyInvoiceAccessToken(token).grant, "delivery");
});

test("classifies invoice ownership without silently changing email", () => {
  const identity = {
    firebaseUid: "firebase-customer-1",
    email: "customer@example.com",
  };
  assert.equal(
    getInvoiceOwnershipState(
      { firebaseUid: "firebase-customer-1", customerDetails: {} },
      identity,
    ),
    "owned",
  );
  assert.equal(
    getInvoiceOwnershipState(
      { customerDetails: { email: "customer@example.com" } },
      identity,
    ),
    "email-match",
  );
  assert.equal(
    getInvoiceOwnershipState({ customerDetails: {} }, identity),
    "email-missing",
  );
  assert.equal(
    getInvoiceOwnershipState(
      { customerDetails: { email: "other@example.com" } },
      identity,
    ),
    "email-different",
  );
  assert.equal(
    getInvoiceOwnershipState(
      { firebaseUid: "another-user", customerDetails: {} },
      identity,
    ),
    "restricted",
  );
  assert.equal(
    getInvoiceOwnershipState(
      {
        firebaseUid: "stale-firebase-user",
        customerDetails: { email: "customer@example.com" },
      },
      identity,
    ),
    "email-match",
  );
});

test("allows a verified Google user to claim an unowned direct invoice link", () => {
  const identity = {
    firebaseUid: "firebase-customer-1",
    email: "customer@example.com",
  };

  assert.equal(
    isDirectInvoiceAccessAllowed(
      { firebaseUid: "firebase-customer-1", customerDetails: {} },
      identity,
    ),
    true,
  );
  assert.equal(
    isDirectInvoiceAccessAllowed(
      { customerDetails: { email: "customer@example.com" } },
      identity,
    ),
    true,
  );
  assert.equal(
    isDirectInvoiceAccessAllowed(
      { customerDetails: { email: "other@example.com" } },
      identity,
    ),
    true,
  );
  assert.equal(
    isDirectInvoiceAccessAllowed({ customerDetails: {} }, identity),
    true,
  );
  assert.equal(
    isDirectInvoiceAccessAllowed(
      { firebaseUid: "another-user", customerDetails: {} },
      identity,
    ),
    false,
  );
  assert.equal(
    isDirectInvoiceAccessAllowed(
      {
        firebaseUid: "stale-firebase-user",
        customerDetails: { email: "customer@example.com" },
      },
      identity,
    ),
    false,
  );
});

test("keeps an existing invoice email and only fills a missing email", () => {
  assert.deepEqual(
    buildDirectInvoiceEmailFields(
      { customerDetails: { email: "existing@example.com" } },
      "google@example.com",
    ),
    {},
  );
  assert.deepEqual(
    buildDirectInvoiceEmailFields(
      { customerDetails: {} },
      " Google@Example.COM ",
    ),
    {
      "customerDetails.email": "google@example.com",
      customerEmailNormalized: "google@example.com",
    },
  );
});

test("deduplicates concurrent delivery attempts by minute", () => {
  const input = {
    invoiceId: "507f1f77bcf86cd799439011",
    firebaseUid: "firebase-customer-1",
    recipientEmail: "delivery@example.com",
    now: 1760000000000,
  };
  const first = buildEmailDeliveryDedupeKey(input);
  const duplicate = buildEmailDeliveryDedupeKey({
    ...input,
    now: input.now + 500,
  });
  const nextMinute = buildEmailDeliveryDedupeKey({
    ...input,
    now: input.now + 60000,
  });
  assert.equal(first, duplicate);
  assert.notEqual(first, nextMinute);
});

test("builds email-update audit metadata without retaining request IP", () => {
  const changedAt = new Date("2026-08-02T00:00:00.000Z");
  const audit = buildInvoiceEmailAudit({
    previousEmail: "old@example.com",
    newEmail: "verified@example.com",
    firebaseUid: "firebase-customer-1",
    requestIp: "203.0.113.10",
    userAgent: "Aquakart test browser",
    changedAt,
  });
  assert.equal(audit.previousEmail, "old@example.com");
  assert.equal(audit.newEmail, "verified@example.com");
  assert.equal(audit.firebaseUid, "firebase-customer-1");
  assert.equal(audit.changedAt, changedAt);
  assert.equal(audit.requestIpHash.length, 64);
  assert.notEqual(audit.requestIpHash, "203.0.113.10");
  assert.equal(audit.userAgentHash.length, 64);
});

test("calculates invoice totals from quantity and price", () => {
  assert.equal(
    calculateInvoiceTotal({
      products: [
        { productPrice: 1000, productQuantity: 2 },
        { productPrice: 500, productQuantity: 1 },
      ],
    }),
    2500,
  );
});
