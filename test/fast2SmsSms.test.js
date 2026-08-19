import assert from "node:assert/strict";
import test from "node:test";
import {
  getFast2SmsSmsStatus,
  sendFast2SmsDlt,
} from "../src/services/notifications/fast2SmsSms.js";

test("keeps SMS fallback disabled until all DLT settings are configured", () => {
  const previous = {
    enabled: process.env.FAST2SMS_SMS_ENABLED,
    apiKey: process.env.FAST2SMS_API_KEY,
    senderId: process.env.FAST2SMS_SMS_SENDER_ID,
    messageId: process.env.FAST2SMS_SMS_INVOICE_MESSAGE_ID,
  };
  process.env.FAST2SMS_SMS_ENABLED = "false";
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.FAST2SMS_SMS_SENDER_ID;
  delete process.env.FAST2SMS_SMS_INVOICE_MESSAGE_ID;

  const status = getFast2SmsSmsStatus();
  assert.equal(status.available, false);
  assert.deepEqual(status.missing, [
    "FAST2SMS_SMS_ENABLED",
    "FAST2SMS_API_KEY",
    "FAST2SMS_SMS_SENDER_ID",
    "FAST2SMS_SMS_INVOICE_MESSAGE_ID",
  ]);

  Object.entries(previous).forEach(([key, value]) => {
    const envKey = {
      enabled: "FAST2SMS_SMS_ENABLED",
      apiKey: "FAST2SMS_API_KEY",
      senderId: "FAST2SMS_SMS_SENDER_ID",
      messageId: "FAST2SMS_SMS_INVOICE_MESSAGE_ID",
    }[key];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  });
});

test("rejects an invalid SMS recipient before provider delivery", async () => {
  await assert.rejects(
    sendFast2SmsDlt({ to: "invalid", messageId: "1" }),
    (error) => error.code === "INVALID_PHONE" && error.statusCode === 400,
  );
});
