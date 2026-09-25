import express from "express";
import {
  recordIncomingWhatsAppEvent,
  recordWhatsAppStatusEvent,
} from "../services/crm/whatsappCrm.js";

const router = express.Router();

const getVerifyToken = () =>
  process.env.META_WA_VERIFY_TOKEN ||
  process.env.WHATSAPP_META_VERIFY_TOKEN ||
  "aquakart_meta_verify_2026";

export const normalizeWebhookPayload = (body = {}) => {
  const events = [];

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactNames = new Map(
        (value.contacts || []).map((contact) => [
          String(contact.wa_id || ""),
          contact.profile?.name || "",
        ]),
      );

      for (const message of value.messages || []) {
        events.push({
          type: "incoming_message",
          field: change.field,
          phoneNumberId: value.metadata?.phone_number_id,
          displayPhoneNumber: value.metadata?.display_phone_number,
          waId: message.from,
          contactName: contactNames.get(String(message.from || "")) || "",
          messageId: message.id,
          messageType: message.type,
          text:
            message.text?.body ||
            message.button?.text ||
            message.interactive?.button_reply?.title ||
            message.interactive?.list_reply?.title ||
            "",
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

router.post("/", async (req, res) => {
  try {
    const events = normalizeWebhookPayload(req.body);

    const results = [];
    for (const event of events) {
      try {
        if (event.type === "incoming_message") {
          results.push(await recordIncomingWhatsAppEvent(event));
        } else if (event.type === "message_status") {
          results.push(await recordWhatsAppStatusEvent(event));
        }
      } catch (eventError) {
        console.error("Meta WhatsApp event persistence failed", {
          type: event.type,
          messageId: event.messageId,
          error: eventError.message,
        });
        results.push({
          status: "failed",
          type: event.type,
          messageId: event.messageId,
          error: eventError.message,
        });
      }
    }

    console.log("Meta WhatsApp webhook processed", {
      eventCount: events.length,
      stored: results.filter((item) =>
        ["stored", "updated", "stored_orphan_status"].includes(item?.status),
      ).length,
      duplicates: results.filter((item) => item?.status === "duplicate").length,
      failed: results.filter((item) => item?.status === "failed").length,
    });

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
    webhook: "persistent",
  });
});

export default router;
