import express from "express";

const router = express.Router();

const getVerifyToken = () =>
  process.env.META_WA_VERIFY_TOKEN ||
  process.env.WHATSAPP_META_VERIFY_TOKEN ||
  "aquakart_meta_verify_2026";

const normalizeWebhookPayload = (body = {}) => {
  const events = [];

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      for (const message of value.messages || []) {
        events.push({
          type: "incoming_message",
          field: change.field,
          phoneNumberId: value.metadata?.phone_number_id,
          displayPhoneNumber: value.metadata?.display_phone_number,
          waId: message.from,
          messageId: message.id,
          messageType: message.type,
          text: message.text?.body,
          timestamp: message.timestamp,
          raw: message,
        });
      }

      for (const status of value.statuses || []) {
        events.push({
          type: "message_status",
          field: change.field,
          phoneNumberId: value.metadata?.phone_number_id,
          displayPhoneNumber: value.metadata?.display_phone_number,
          waId: status.recipient_id,
          messageId: status.id,
          status: status.status,
          timestamp: status.timestamp,
          errors: status.errors,
          raw: status,
        });
      }
    }
  }

  return events;
};

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === getVerifyToken()) {
    console.log("Meta WhatsApp webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.warn("Meta WhatsApp webhook verification failed", {
    mode,
    receivedToken: token ? "[received]" : "[missing]",
  });

  return res.sendStatus(403);
});

router.post("/", (req, res) => {
  try {
    const events = normalizeWebhookPayload(req.body);

    console.log("Meta WhatsApp webhook received", {
      eventCount: events.length,
      events,
    });

    // TODO: Persist events to DB and connect to CRM conversation/message logs.
    // Incoming messages should create/update CRM leads.
    // Status events should update sent/delivered/read/failed message status.
    return res.sendStatus(200);
  } catch (error) {
    console.error("Error handling Meta WhatsApp webhook", error);
    return res.sendStatus(200);
  }
});

router.get("/health", (_req, res) => {
  res.json({
    status: "active",
    provider: "meta_whatsapp",
    webhook: "ready",
  });
});

export default router;
