import assert from "node:assert/strict";
import test from "node:test";
import sendEmail from "../src/notifications/email/send-email.js";

test("fails safely when SMTP is not configured", async () => {
  const original = {
    host: process.env.SMTP_HOST,
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
  };
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;

  const result = await sendEmail({
    email: "customer@example.com",
    subject: "Invoice",
    message: "Invoice",
    content: "<p>Invoice</p>",
  });

  assert.equal(result.success, false);
  assert.equal(result.code, "EMAIL_NOT_CONFIGURED");
  assert.equal(Object.hasOwn(result, "error"), false);

  if (original.host) process.env.SMTP_HOST = original.host;
  if (original.user) process.env.SMTP_USER = original.user;
  if (original.password) process.env.SMTP_PASSWORD = original.password;
});
