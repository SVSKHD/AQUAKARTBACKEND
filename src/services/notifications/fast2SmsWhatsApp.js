import axios from "axios";

const DEFAULT_BASE_URL = "https://www.fast2sms.com";

export const normalizeWhatsAppNumber = (value = "") => {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
};

export const getFast2SmsWhatsAppConfig = () => ({
  apiKey:
    process.env.FAST2SMS_API_KEY ||
    process.env.FAST2SMS_AUTHORIZATION_KEY ||
    "",
  baseUrl: process.env.FAST2SMS_BASE_URL || DEFAULT_BASE_URL,
  phoneNumberId:
    process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID ||
    process.env.FAST2SMS_PHONE_NUMBER_ID ||
    "",
  invoiceMessageId:
    process.env.FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID ||
    process.env.FAST2SMS_WHATSAPP_MESSAGE_ID ||
    "",
});

const getMissingWhatsAppConfiguration = (config, { invoice = true } = {}) => {
  const missing = [];
  if (!config.apiKey) missing.push("FAST2SMS_API_KEY");
  if (!config.phoneNumberId)
    missing.push("FAST2SMS_WHATSAPP_PHONE_NUMBER_ID");
  if (invoice && !config.invoiceMessageId)
    missing.push("FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID");
  return missing;
};

export const getFast2SmsWhatsAppStatus = () => {
  const config = getFast2SmsWhatsAppConfig();
  const missing = getMissingWhatsAppConfiguration(config);

  return {
    provider: "fast2sms",
    available: missing.length === 0,
    configured: missing.length === 0,
    mode: "whatsapp-template",
    missing,
    sms: { available: false, mode: "placeholder" },
  };
};

const providerError = (message, code, statusCode = 502, details) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

export const listFast2SmsWhatsAppTemplates = async () => {
  const config = getFast2SmsWhatsAppConfig();
  const missing = getMissingWhatsAppConfiguration(config, { invoice: false });
  if (missing.length) {
    throw providerError(
      `Fast2SMS WhatsApp is missing: ${missing.join(", ")}`,
      "FAST2SMS_NOT_CONFIGURED",
      503,
      { missing },
    );
  }
  const response = await axios.get(
    `${config.baseUrl}/dev/dlt_manager/whatsapp`,
    {
      params: {
        type: "template",
        ...(config.phoneNumberId
          ? { phone_number_id: config.phoneNumberId }
          : {}),
      },
      headers: { Authorization: config.apiKey },
      timeout: 15000,
    },
  );
  return response.data;
};

export const sendFast2SmsWhatsAppTemplate = async ({
  to,
  messageId,
  variables = [],
  mediaUrl,
  documentFilename,
  udf = [],
}) => {
  const config = getFast2SmsWhatsAppConfig();
  const number = normalizeWhatsAppNumber(to);
  if (!number)
    throw providerError(
      "Enter a valid 10-digit Indian WhatsApp number",
      "INVALID_PHONE",
      400,
    );
  const missing = getMissingWhatsAppConfiguration(config, { invoice: false });
  if (missing.length) {
    throw providerError(
      `Fast2SMS WhatsApp is missing: ${missing.join(", ")}`,
      "FAST2SMS_NOT_CONFIGURED",
      503,
      { missing },
    );
  }
  if (!messageId) {
    throw providerError(
      "An approved Fast2SMS WhatsApp message ID is required",
      "WHATSAPP_TEMPLATE_REQUIRED",
      400,
    );
  }

  const params = {
    message_id: messageId,
    phone_number_id: config.phoneNumberId,
    numbers: number,
  };
  if (variables.length) params.variables_values = variables.join("|");
  if (mediaUrl) params.media_url = mediaUrl;
  if (documentFilename) params.document_filename = documentFilename;
  udf.slice(0, 3).forEach((value, index) => {
    if (value !== undefined && value !== null && value !== "")
      params[`udf${index + 1}`] = String(value);
  });

  try {
    const response = await axios.get(`${config.baseUrl}/dev/whatsapp`, {
      params,
      headers: { Authorization: config.apiKey },
      timeout: 15000,
    });
    if (response.data?.success === false) {
      throw providerError(
        response.data?.message || "Fast2SMS rejected the WhatsApp message",
        "FAST2SMS_REJECTED",
        502,
        response.data,
      );
    }
    return { success: true, provider: "fast2sms", data: response.data };
  } catch (error) {
    if (error.code?.startsWith("FAST2SMS_")) throw error;
    throw providerError(
      error.response?.data?.message ||
        error.message ||
        "Fast2SMS WhatsApp request failed",
      "FAST2SMS_REQUEST_FAILED",
      error.response?.status || 502,
      error.response?.data,
    );
  }
};
