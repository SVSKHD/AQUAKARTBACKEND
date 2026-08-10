import assert from "node:assert/strict";
import test from "node:test";
import {
  getFast2SmsWhatsAppStatus,
  normalizeWhatsAppNumber,
  sendFast2SmsWhatsAppTemplate,
} from "../src/services/notifications/fast2SmsWhatsApp.js";

test("normalizes supported Indian WhatsApp numbers", () => {
  assert.equal(normalizeWhatsAppNumber("98765 43210"), "9876543210");
  assert.equal(normalizeWhatsAppNumber("+91-98765-43210"), "9876543210");
  assert.equal(normalizeWhatsAppNumber("123"), null);
});

test("reports missing Fast2SMS configuration without exposing values", () => {
  const previous = {
    apiKey: process.env.FAST2SMS_API_KEY,
    phoneId: process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID,
    messageId: process.env.FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID,
  };
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID;
  const status = getFast2SmsWhatsAppStatus();
  assert.equal(status.available, false);
  assert.deepEqual(status.missing, [
    "FAST2SMS_API_KEY",
    "FAST2SMS_WHATSAPP_PHONE_NUMBER_ID",
    "FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID",
  ]);
  assert.equal("apiKey" in status, false);
  if (previous.apiKey) process.env.FAST2SMS_API_KEY = previous.apiKey;
  if (previous.phoneId)
    process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID = previous.phoneId;
  if (previous.messageId)
    process.env.FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID = previous.messageId;
});

test("rejects invalid recipients before calling Fast2SMS", async () => {
  await assert.rejects(
    sendFast2SmsWhatsAppTemplate({ to: "invalid", messageId: "1" }),
    (error) => error.code === "INVALID_PHONE" && error.statusCode === 400,
  );
});
