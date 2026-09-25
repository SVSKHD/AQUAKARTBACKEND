import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import AquaLead from "../src/models/crm/lead.js";
import AquaActivity from "../src/models/crm/activity.js";
import AquaDeal from "../src/models/crm/deal.js";
import { calculateLeadScore } from "../src/utils/crmLeadScore.js";

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


test("CRM lead supports the Aquakart sales pipeline and softener qualification", async () => {
  const lead = new AquaLead({
    contact_name: "Softener Customer",
    phone: "9999999999",
    status: "water_details",
    qualification: {
      locality: "Kondapur",
      pincode: "500084",
      water_source: "borewell",
      hardness_ppm: 450,
      bathrooms: 3,
      residents: 5,
      product_interest: "automatic",
      urgency: "7_days",
      budget_max: 100000,
      recommended_capacity_liters: 25,
    },
    stage_history: [
      {
        from: "contacted",
        to: "water_details",
      },
    ],
  });

  await lead.validate();

  assert.equal(lead.status, "water_details");
  assert.equal(lead.qualification.water_source, "borewell");
  assert.equal(lead.qualification.hardness_ppm, 450);
  assert.equal(lead.stage_history[0].to, "water_details");
});

test("CRM lead follow-ups support reminders and completion metadata", async () => {
  const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const reminderAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
  const lead = new AquaLead({
    contact_name: "Follow-up Customer",
    phone: "9999999998",
    follow_ups: [
      {
        scheduled_for: scheduledFor,
        reminder_at: reminderAt,
        reminder_status: "pending",
        status: "scheduled",
        note: "Call after water test",
      },
    ],
    next_follow_up: scheduledFor,
  });

  await lead.validate();

  assert.equal(lead.follow_ups.length, 1);
  assert.equal(lead.follow_ups[0].reminder_status, "pending");
  assert.equal(lead.follow_ups[0].status, "scheduled");
});

test("lead scoring promotes high intent softener enquiries", () => {
  const result = calculateLeadScore({
    status: "site_visit",
    source: "planner",
    phone: "9999999999",
    email: "customer@example.com",
    next_follow_up: new Date(Date.now() + 60 * 60 * 1000),
    qualification: {
      locality: "Gachibowli",
      pincode: "500032",
      water_source: "borewell",
      hardness_ppm: 500,
      bathrooms: 4,
      residents: 5,
      product_interest: "whole_house",
      budget_max: 120000,
      urgency: "immediate",
      recommended_capacity_liters: 30,
    },
  });

  assert.equal(result.band, "hot");
  assert.ok(result.score >= 70);
  assert.ok(result.score <= 100);
  assert.equal(result.breakdown.hardness, 12);
});

test("lead scoring makes won leads 100 and lost leads 0", () => {
  assert.equal(calculateLeadScore({ status: "won" }).score, 100);
  assert.equal(calculateLeadScore({ status: "lost" }).score, 0);
});

test("CRM deal supports offline customer ids and structured loss reasons", async () => {
  const deal = new AquaDeal({
    title: "Manual softener opportunity",
    amount: 15000,
    stage: "closed_lost",
    customer_id: "offline:919999999999",
    customer_type: "offline",
    lost_reason: {
      category: "competitor",
      competitor: "Another supplier",
      details: "Customer selected another quotation",
    },
  });

  await deal.validate();

  assert.equal(deal.customer_type, "offline");
  assert.equal(deal.lost_reason.category, "competitor");
});
