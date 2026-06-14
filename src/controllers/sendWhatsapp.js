import axios from "axios";

const BASE = process.env.WHATSAPPAPI || "https://app.whatsera.com";
const KEY = process.env.WHATSAPPAPIKEY;

const normalizePhoneNumber = (no = "") => {
  const digits = String(no).replace(/\D/g, "");

  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;

  return null;
};

const buildFailureResponse = ({ stage, message, details, statusCode = 400 }) => ({
  status: false,
  stage,
  message,
  details,
  statusCode,
});

const sendMessage = async (req, res) => {
  const { no } = req.params;
  const { message } = req.query;

  return sendWhatsAppText({ no, message, res });
};

const sendWhatsAppPostMethod = async (req, res) => {
  const { no, message } = req.body;

  return sendWhatsAppText({ no, message, res });
};

const sendWhatsAppText = async ({ no, message, res }) => {
  const mobile = normalizePhoneNumber(no);
  const text = typeof message === "string" ? message.trim() : "";

  if (!KEY) {
    return res.status(500).json(
      buildFailureResponse({
        stage: "CONFIG_ERROR",
        message: "WhatsApp provider key is missing. Set WHATSAPPAPIKEY in backend environment.",
        statusCode: 500,
      }),
    );
  }

  if (!mobile) {
    return res.status(400).json(
      buildFailureResponse({
        stage: "VALIDATION_ERROR",
        message: "Invalid WhatsApp number. Send a 10-digit Indian mobile number or a 12-digit number starting with 91.",
        details: { receivedNo: no },
      }),
    );
  }

  if (!text) {
    return res.status(400).json(
      buildFailureResponse({
        stage: "VALIDATION_ERROR",
        message: "WhatsApp message is required and cannot be empty.",
      }),
    );
  }

  try {
    const payload = {
      accessToken: KEY,
      mobile,
      text,
    };

    const response = await axios.post(`${BASE}/api/send/text`, payload, {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    console.log("WhatsApp provider response:", response.data);

    if (response.data?.success) {
      return res.status(200).json({
        status: true,
        stage: "SENT",
        message: "Message sent successfully",
        providerResponse: response.data,
      });
    }

    return res.status(400).json(
      buildFailureResponse({
        stage: "PROVIDER_REJECTED",
        message:
          response.data?.error ||
          response.data?.message ||
          "WhatsApp provider rejected the message.",
        details: response.data,
      }),
    );
  } catch (error) {
    const providerStatus = error.response?.status;
    const providerData = error.response?.data;

    console.error("WhatsApp send failed:", {
      providerStatus,
      providerData,
      errorMessage: error.message,
    });

    return res.status(providerStatus || 500).json(
      buildFailureResponse({
        stage: providerStatus ? "PROVIDER_HTTP_ERROR" : "BACKEND_HTTP_ERROR",
        message:
          providerData?.error ||
          providerData?.message ||
          error.message ||
          "Unable to send WhatsApp message.",
        details: {
          providerStatus,
          providerData,
          mobile,
        },
        statusCode: providerStatus || 500,
      }),
    );
  }
};

const WhatsappOperations = {
  sendMessage,
  sendWhatsAppPostMethod,
};

export default WhatsappOperations;
