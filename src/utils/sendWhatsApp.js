import axios from "axios";

const BASE = process.env.WHATSAPPAPI || "https://app.whatsera.com";
const KEY = process.env.WHATSAPPAPIKEY || "685e311c3d3aacf917650e6f";

export const normalizeIndianWhatsAppNumber = (no = "") => {
  const digits = String(no).replace(/\D/g, "");

  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;

  return null;
};

const sendWhatsAppMessage = async (no, message) => {
  const mobile = normalizeIndianWhatsAppNumber(no);
  const text = typeof message === "string" ? message.trim() : "";

  if (!KEY) {
    return {
      success: false,
      message: "WhatsApp provider key is missing",
      stage: "CONFIG_ERROR",
    };
  }

  if (!mobile) {
    return {
      success: false,
      message:
        "Invalid WhatsApp number. Use a 10-digit Indian mobile number or 91-prefixed 12-digit number.",
      stage: "VALIDATION_ERROR",
    };
  }

  if (!text) {
    return {
      success: false,
      message: "WhatsApp message is required",
      stage: "VALIDATION_ERROR",
    };
  }

  try {
    const response = await axios.post(
      `${BASE}/api/send/text`,
      {
        accessToken: KEY,
        mobile,
        text,
      },
      {
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    if (response.data?.success) {
      return {
        success: true,
        message: "Message sent successfully",
        providerResponse: response.data,
        mobile,
      };
    }

    return {
      success: false,
      message:
        response.data?.error ||
        response.data?.message ||
        "WhatsApp provider rejected the message",
      providerResponse: response.data,
      mobile,
      stage: "PROVIDER_REJECTED",
    };
  } catch (error) {
    return {
      success: false,
      message:
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        "Unable to send WhatsApp message",
      providerResponse: error.response?.data,
      mobile,
      stage: error.response?.status ? "PROVIDER_HTTP_ERROR" : "BACKEND_HTTP_ERROR",
    };
  }
};

export default sendWhatsAppMessage;
