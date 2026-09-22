import assert from "node:assert/strict";
import test from "node:test";
import { buildOrderCreatedNotification } from "../src/services/crmNotifications.js";

test("builds ecommerce order notification payload", () => {
  const payload = buildOrderCreatedNotification({
    order: {
      _id: "68d0a1b2c3d4e5f678901234",
      orderId: "AK-100",
      totalAmount: 15500,
    },
    source: "ecommerce",
    customerName: "Ravi",
  });

  assert.equal(payload.type, "order.created");
  assert.equal(payload.entityType, "order");
  assert.equal(payload.title, "New Ecommerce Order");
  assert.equal(payload.eventKey, "order.created:68d0a1b2c3d4e5f678901234");
  assert.equal(payload.metadata.source, "ecommerce");
  assert.match(payload.message, /AK-100/);
  assert.match(payload.message, /Ravi/);
});

test("builds CRM order notification payload", () => {
  const payload = buildOrderCreatedNotification({
    order: {
      _id: "68d0a1b2c3d4e5f678901235",
      orderNumber: "AK-ORD-20260922-001",
      grandTotal: 8500,
      customer: { name: "Meera" },
    },
    source: "crm",
  });

  assert.equal(payload.title, "New CRM Order");
  assert.equal(payload.metadata.amount, 8500);
  assert.equal(payload.metadata.customerName, "Meera");
});
