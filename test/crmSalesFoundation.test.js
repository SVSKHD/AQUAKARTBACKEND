import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import AquaLead from "../src/models/crm/lead.js";
import AquaActivity from "../src/models/crm/activity.js";
import AquaDeal from "../src/models/crm/deal.js";

test("CRM lead model matches the existing Leads tab contract", async () => {
  const lead = new AquaLead({
    company_name: "Test Home",
    contact_name: "Test Customer",
    email: "customer@example.com",
    phone: "9999999999",
    status: "new",
    source: "website",
    payment_status: "pending",
  });

  await lead.validate();

  const json = lead.toJSON();
  assert.equal(json.contact_name, "Test Customer");
  assert.equal(json.status, "new");
  assert.equal(json.payment_status, "pending");
  assert.ok(json.id);
});

test("CRM lead rejects unsupported statuses", async () => {
  const lead = new AquaLead({
    contact_name: "Test Customer",
    phone: "9999999999",
    status: "invalid-stage",
  });

  await assert.rejects(() => lead.validate(), /status/);
});

test("CRM activity model supports lead customer and deal activities", async () => {
  for (const related_to of ["lead", "customer", "deal"]) {
    const activity = new AquaActivity({
      related_to,
      related_id: new mongoose.Types.ObjectId().toString(),
      type: "call",
      title: "Follow up",
      status: "pending",
    });

    await activity.validate();
    assert.equal(activity.related_to, related_to);
  }
});

test("CRM activity requires a related record", async () => {
  const activity = new AquaActivity({
    related_to: "lead",
    type: "task",
    title: "Missing relation",
  });

  await assert.rejects(() => activity.validate(), /related_id/);
});

test("CRM deal model supports current CRM stages and sales relationships", async () => {
  const deal = new AquaDeal({
    title: "Whole home softener",
    amount: 95000,
    stage: "proposal",
    probability: 60,
    lead_id: new mongoose.Types.ObjectId(),
    customer_id: new mongoose.Types.ObjectId(),
    quotation_id: new mongoose.Types.ObjectId(),
    order_id: new mongoose.Types.ObjectId(),
  });

  await deal.validate();

  const json = deal.toJSON();
  assert.equal(json.stage, "proposal");
  assert.equal(json.probability, 60);
  assert.ok(json.id);
});

test("CRM deal probability stays between zero and one hundred", async () => {
  const deal = new AquaDeal({
    title: "Invalid probability deal",
    amount: 1000,
    probability: 101,
  });

  await assert.rejects(() => deal.validate(), /Probability/);
});
