import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailDeliveryDedupeKey,
  buildDirectInvoiceEmailFields,
  buildInvoiceEmailAudit,
  calculateInvoiceTotal,
  classifyInvoiceAccessScope,
  getInvoiceOwnershipState,
  getInvoiceProductPriceTotal,
  hashToken,
  maskEmail,
  normalizeEmail,
  normalizeIndianPhone,
  signInvoiceAccessToken,
  validateEmail,
  verifyInvoiceAccessToken,
} from "../src/utils/invoiceAccess.js";
import { buildInvoiceProfile } from "../src/services/invoiceUserEnrichment.js";

test("distinguishes a stale invoice cookie from an invalid invoice id", () => {
  const authorizedId = "6a6ffacfaafb698d0de99a7c";

  assert.equal(
    classifyInvoiceAccessScope("6a7032be32c7bfcc925aa611", [authorizedId]),
    "mismatch",
  );
  assert.equal(
    classifyInvoiceAccessScope(authorizedId, [authorizedId]),
    "allowed",
  );
  assert.equal(
    classifyInvoiceAccessScope("not-an-invoice-id", [authorizedId]),
    "invalid",
  );
});

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

test("supports Firebase-verified direct-link access without ownership", () => {
  process.env.INVOICE_ACCESS_SECRET =
    "test-invoice-secret-with-sufficient-length";
  const token = signInvoiceAccessToken({
    invoiceIds: ["507f1f77bcf86cd799439011"],
    email: "viewer@example.com",
    firebaseUid: "firebase-viewer-1",
    grant: "direct",
  });
  const payload = verifyInvoiceAccessToken(token);
  assert.equal(payload.grant, "direct");
  assert.deepEqual(payload.invoiceIds, ["507f1f77bcf86cd799439011"]);
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

test("sums each invoice product line price once for invoice discovery", () => {
  assert.equal(
    getInvoiceProductPriceTotal({
      products: [
        { productPrice: 63000, productQuantity: 1 },
        { productPrice: 262000, productQuantity: 2 },
      ],
    }),
    325000,
  );
  assert.equal(
    getInvoiceProductPriceTotal({
      products: [{ productPrice: "invalid", productQuantity: 50 }],
    }),
    0,
  );
});

test("builds a user profile from the newest available invoice fields", () => {
  const profile = buildInvoiceProfile([
    {
      _id: "507f1f77bcf86cd799439011",
      invoiceNo: "AK-OLD",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      customerDetails: {
        name: "Old Name",
        phone: 9876543210,
        address: "Old address",
      },
    },
    {
      _id: "507f1f77bcf86cd799439012",
      invoiceNo: "AK-NEW",
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      customerDetails: {
        name: "Madhu Sudhan Rao",
        phone: "+91 91234 56789",
        address: "Hyderabad, Telangana",
      },
    },
  ]);

  assert.equal(profile.firstName, "Madhu");
  assert.equal(profile.lastName, "Sudhan Rao");
  assert.equal(profile.phone, "9123456789");
  assert.equal(profile.address, "Hyderabad, Telangana");
  assert.deepEqual(
    profile.invoices.map((invoice) => invoice.invoiceNo),
    ["AK-NEW", "AK-OLD"],
  );
});
