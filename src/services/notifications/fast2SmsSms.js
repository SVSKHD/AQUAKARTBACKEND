import axios from "axios";
import { normalizeWhatsAppNumber } from "./fast2SmsWhatsApp.js";

const DEFAULT_BASE_URL = "https://www.fast2sms.com";

export const getFast2SmsSmsConfig = () => ({
  enabled: String(process.env.FAST2SMS_SMS_ENABLED || "false") === "true",
  apiKey: process.env.FAST2SMS_API_KEY || "",
  baseUrl: process.env.FAST2SMS_BASE_URL || DEFAULT_BASE_URL,
  route: process.env.FAST2SMS_SMS_ROUTE || "dlt",
  senderId: process.env.FAST2SMS_SMS_SENDER_ID || "",
  invoiceMessageId: process.env.FAST2SMS_SMS_INVOICE_MESSAGE_ID || "",
});

export const getFast2SmsSmsStatus = () => {
  const config = getFast2SmsSmsConfig();
  const missing = [];
  if (!config.enabled) missing.push("FAST2SMS_SMS_ENABLED");
  if (!config.apiKey) missing.push("FAST2SMS_API_KEY");
  if (!config.senderId) missing.push("FAST2SMS_SMS_SENDER_ID");
  if (!config.invoiceMessageId) missing.push("FAST2SMS_SMS_INVOICE_MESSAGE_ID");
  return {
    provider: "fast2sms",
    available: missing.length === 0,
    configured: missing.length === 0,
    mode: "sms-dlt",
    missing,
  };
};

const providerError = (message, code, statusCode = 502, details) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

export const sendFast2SmsDlt = async ({ to, messageId, variables = [] }) => {
  const config = getFast2SmsSmsConfig();
  const number = normalizeWhatsAppNumber(to);
  if (!number)
    throw providerError(
      "Enter a valid 10-digit Indian mobile number",
      "INVALID_PHONE",
      400,
    );
  if (!config.enabled || !config.apiKey || !config.senderId) {
    throw providerError(
      "Fast2SMS SMS is not configured",
      "FAST2SMS_SMS_NOT_CONFIGURED",
      503,
    );
  }
  if (!messageId)
    throw providerError(
      "An approved Fast2SMS DLT message ID is required",
      "SMS_TEMPLATE_REQUIRED",
      400,
    );

  try {
    const response = await axios.get(`${config.baseUrl}/dev/bulkV2`, {
      params: {
        route: config.route,
        sender_id: config.senderId,
        message: messageId,
        variables_values: variables.join("|"),
        flash: 0,
        numbers: number,
      },
      headers: { Authorization: config.apiKey },
      timeout: 15000,
    });
    if (response.data?.return === false || response.data?.success === false) {
      throw providerError(
        response.data?.message || "Fast2SMS rejected the SMS",
        "FAST2SMS_SMS_REJECTED",
        502,
        response.data,
      );
    }
    return {
      success: true,
      provider: "fast2sms",
      channel: "sms",
      data: response.data,
    };
  } catch (error) {
    if (error.code?.startsWith("FAST2SMS_")) throw error;
    throw providerError(
      error.response?.data?.message ||
        error.message ||
        "Fast2SMS SMS request failed",
      "FAST2SMS_SMS_REQUEST_FAILED",
      error.response?.status || 502,
      error.response?.data,
    );
  }
};
