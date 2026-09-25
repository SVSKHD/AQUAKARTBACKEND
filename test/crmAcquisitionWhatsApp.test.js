import test from "node:test";
import assert from "node:assert/strict";
import AquaLead from "../src/models/crm/lead.js";
import AquaQuotation from "../src/models/crm/quotation.js";
import WhatsAppMessage from "../src/models/crm/whatsappMessage.js";
import {
  buildPlannerQualification,
  calculatePlannerCapacity,
} from "../src/services/crm/leadIntake.js";
import { extractProviderMessageId } from "../src/services/crm/whatsappCrm.js";
import { normalizeWebhookPayload } from "../src/routes/whatsappMetaWebhook.js";

test("planner capacity matches the customer-facing planner rules", () => {
  assert.equal(
    calculatePlannerCapacity({
      residents: "3-4",
      coverage: "whole-home",
      hardness: "hard",
    }),
    32,
  );

  assert.equal(
    calculatePlannerCapacity({
      residents: "3-4",
      coverage: "whole-home",
      hardness: "unknown",
    }),
    35,
  );

  assert.equal(
    calculatePlannerCapacity({
      residents: "1-2",
      coverage: "bathroom",
      hardness: "very-hard",
    }),
    12,
  );
});

test("planner answers map into CRM softener qualification", () => {
  const qualification = buildPlannerQualification({
    answers: {
      residents: "3-4",
      coverage: "whole-home",
      hardness: "very-hard",
    },
    recommendedProduct: {
      product_id: "product-1",
      title: "30L Automatic Softener",
    },
  });

  assert.equal(qualification.residents, 4);
  assert.equal(qualification.residents_range, "3-4");
  assert.equal(qualification.coverage, "whole-home");
  assert.equal(qualification.hardness_level, "very_hard");
  assert.equal(qualification.product_interest, "whole_house");
  assert.equal(qualification.recommended_product_id, "product-1");
  assert.equal(qualification.recommended_product_name, "30L Automatic Softener");
  assert.equal(qualification.recommended_capacity_liters, 40);
});

test("lead model stores planner and product intake history", async () => {
  const lead = new AquaLead({
    contact_name: "Planner Customer",
    phone: "9876543210",
    source: "planner",
    last_intake_channel: "planner",
    last_intake_at: new Date(),
    intake_events: [
      {
        channel: "planner",
        source: "planner",
        page_path: "/softener-planner",
        product: {
          product_id: "p1",
          title: "Automatic Softener",
          slug: "automatic-softener",
          price: 50000,
        },
        planner: {
          residents: "3-4",
          coverage: "whole-home",
          hardness: "hard",
          required_capacity_liters: 32,
          recommendation_product_ids: ["p1"],
          recommendation_product_names: ["Automatic Softener"],
        },
      },
    ],
  });

  await lead.validate();

  assert.equal(lead.intake_events.length, 1);
  assert.equal(lead.intake_events[0].channel, "planner");
  assert.equal(lead.intake_events[0].planner.required_capacity_liters, 32);
  assert.equal(lead.intake_events[0].product.product_id, "p1");
});

test("Meta webhook parser captures contact name, inbound text and delivery status", () => {
  const events = normalizeWebhookPayload({
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                phone_number_id: "business-phone-id",
                display_phone_number: "919014774667",
              },
              contacts: [
                {
                  wa_id: "919876543210",
                  profile: { name: "Test Customer" },
                },
              ],
              messages: [
                {
                  from: "919876543210",
                  id: "wamid.inbound-1",
                  type: "text",
                  timestamp: "1760000000",
                  text: { body: "Need a water softener" },
                },
              ],
              statuses: [
                {
                  recipient_id: "919876543210",
                  id: "wamid.outbound-1",
                  status: "delivered",
                  timestamp: "1760000001",
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "incoming_message");
  assert.equal(events[0].contactName, "Test Customer");
  assert.equal(events[0].text, "Need a water softener");
  assert.equal(events[1].type, "message_status");
  assert.equal(events[1].status, "delivered");
});

test("WhatsApp messages can be stored without a provider message id", async () => {
  const base = {
    conversation_id: "507f1f77bcf86cd799439011",
    direction: "outbound",
    provider: "fast2sms",
    provider_status: "sent",
    message_type: "template",
  };

  const first = new WhatsAppMessage(base);
  const second = new WhatsAppMessage(base);

  await first.validate();
  await second.validate();

  assert.equal(first.provider_message_id, undefined);
  assert.equal(second.provider_message_id, undefined);
});

test("Fast2SMS provider message identifiers are extracted from common response shapes", () => {
  assert.equal(
    extractProviderMessageId({ data: { message_id: "message-1" } }),
    "message-1",
  );
  assert.equal(
    extractProviderMessageId({ data: { data: { request_id: "request-2" } } }),
    "request-2",
  );
});

test("quotation model includes WhatsApp follow-up automation defaults", async () => {
  const quotation = new AquaQuotation({
    quotationNo: "AQUO|TEST|0001",
    customerDetails: {
      name: "Test Customer",
      phone: 9876543210,
    },
    products: [
      {
        productName: "Water Softener",
        productQuantity: 1,
        productPrice: 20000,
      },
    ],
    totalAmount: 20000,
  });

  await quotation.validate();

  assert.equal(quotation.whatsapp.followUpEnabled, false);
  assert.equal(quotation.whatsapp.followUpCount, 0);
  assert.equal(quotation.whatsapp.maxFollowUps, 3);
  assert.equal(quotation.whatsapp.followUpIntervalHours, 24);
});
