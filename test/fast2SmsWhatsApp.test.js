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
    legacyApiKey: process.env.FAST2SMS_AUTHORIZATION_KEY,
    legacyPhoneId: process.env.FAST2SMS_PHONE_NUMBER_ID,
    legacyMessageId: process.env.FAST2SMS_WHATSAPP_MESSAGE_ID,
  };
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID;
  delete process.env.FAST2SMS_AUTHORIZATION_KEY;
  delete process.env.FAST2SMS_PHONE_NUMBER_ID;
  delete process.env.FAST2SMS_WHATSAPP_MESSAGE_ID;
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
  if (previous.legacyApiKey)
    process.env.FAST2SMS_AUTHORIZATION_KEY = previous.legacyApiKey;
  if (previous.legacyPhoneId)
    process.env.FAST2SMS_PHONE_NUMBER_ID = previous.legacyPhoneId;
  if (previous.legacyMessageId)
    process.env.FAST2SMS_WHATSAPP_MESSAGE_ID = previous.legacyMessageId;
});

test("supports legacy Fast2SMS Jenkins variable names", async () => {
  const previous = {
    apiKey: process.env.FAST2SMS_API_KEY,
    phoneId: process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID,
    messageId: process.env.FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID,
    legacyApiKey: process.env.FAST2SMS_AUTHORIZATION_KEY,
    legacyPhoneId: process.env.FAST2SMS_PHONE_NUMBER_ID,
    legacyMessageId: process.env.FAST2SMS_WHATSAPP_MESSAGE_ID,
  };
  delete process.env.FAST2SMS_API_KEY;
  delete process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID;
  process.env.FAST2SMS_AUTHORIZATION_KEY = "legacy-key";
  process.env.FAST2SMS_PHONE_NUMBER_ID = "legacy-phone";
  process.env.FAST2SMS_WHATSAPP_MESSAGE_ID = "legacy-template";

  const { getFast2SmsWhatsAppConfig } = await import(
    "../src/services/notifications/fast2SmsWhatsApp.js"
  );
  const config = getFast2SmsWhatsAppConfig();
  assert.equal(config.apiKey, "legacy-key");
  assert.equal(config.phoneNumberId, "legacy-phone");
  assert.equal(config.invoiceMessageId, "legacy-template");

  [
    ["FAST2SMS_API_KEY", previous.apiKey],
    ["FAST2SMS_WHATSAPP_PHONE_NUMBER_ID", previous.phoneId],
    ["FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID", previous.messageId],
    ["FAST2SMS_AUTHORIZATION_KEY", previous.legacyApiKey],
    ["FAST2SMS_PHONE_NUMBER_ID", previous.legacyPhoneId],
    ["FAST2SMS_WHATSAPP_MESSAGE_ID", previous.legacyMessageId],
  ].forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

test("rejects invalid recipients before calling Fast2SMS", async () => {
  await assert.rejects(
    sendFast2SmsWhatsAppTemplate({ to: "invalid", messageId: "1" }),
    (error) => error.code === "INVALID_PHONE" && error.statusCode === 400,
  );
});
