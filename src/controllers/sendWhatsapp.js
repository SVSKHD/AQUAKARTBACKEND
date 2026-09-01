import {
  getFast2SmsWhatsAppStatus,
  listFast2SmsWhatsAppTemplates,
  sendFast2SmsWhatsAppTemplate,
} from "../services/notifications/fast2SmsWhatsApp.js";

const sendMessage = async (req, res) =>
  res.status(405).json({
    status: false,
    code: "WHATSAPP_TEMPLATES_REQUIRED",
    message: "Use POST /v1/notify/send-whatsapp with an approved template.",
  });

const getStatus = (req, res) =>
  res
    .status(200)
    .json({ success: true, whatsapp: getFast2SmsWhatsAppStatus() });

const getTemplates = async (req, res) => {
  try {
    const data = await listFast2SmsWhatsAppTemplates();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      success: false,
      code: error.code || "FAST2SMS_REQUEST_FAILED",
      message: error.message,
      missingConfiguration: error.details?.missing || [],
    });
  }
};

const sendWhatsAppPostMethod = async (req, res) => {
  try {
    const result = await sendFast2SmsWhatsAppTemplate({
      to: req.body?.no || req.body?.to,
      messageId: req.body?.messageId,
      variables: Array.isArray(req.body?.variables) ? req.body.variables : [],
      mediaUrl: req.body?.mediaUrl,
      documentFilename: req.body?.documentFilename,
      udf: Array.isArray(req.body?.udf) ? req.body.udf : [],
    });
    return res.status(200).json({ status: true, stage: "SENT", ...result });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      status: false,
      stage: error.code || "FAST2SMS_REQUEST_FAILED",
      message: error.message,
      details: error.details,
      missingConfiguration: error.details?.missing || [],
    });
  }
};

export default { sendMessage, sendWhatsAppPostMethod, getStatus, getTemplates };
