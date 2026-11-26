// Adds the first Transit rate card on whichever database DB_URL points at.
// Prices live in MongoDB, not in code: this script only writes the initial
// V1 card, and only when no rate card exists yet. Admins change prices later
// with POST /v1/crm/transit/pricing.
//
//   npm run transit:seed-pricing             show what would be written
//   npm run transit:seed-pricing -- --apply  write it
import "../../config.js";
import mongoose from "mongoose";
import TransitRateCard from "../models/transit/rateCard.js";
import { validateRateCardInput } from "../services/transit/rules.js";

const INITIAL_CARD = {
  name: "Transit V1 initial rates",
  tiers: [
    { minKm: 0, maxKm: 10, price: 350 },
    { minKm: 10, maxKm: 15, price: 400 },
    { minKm: 15, maxKm: null, price: 500 },
  ],
  cashIncentive: 100,
};

const apply = process.argv.includes("--apply");
if (!process.env.DB_URL) throw new Error("DB_URL is required.");

const card = validateRateCardInput(INITIAL_CARD, new Date());
console.log("Rate card:", JSON.stringify(card, null, 2));

await mongoose.connect(process.env.DB_URL);
try {
  const existing = await TransitRateCard.countDocuments({});
  if (existing) {
    console.log(`Skipped: ${existing} rate card(s) already exist.`);
  } else if (!apply) {
    console.log("Dry run. Re-run with --apply to write it.");
  } else {
    const saved = await TransitRateCard.create({
      ...card,
      status: "active",
      history: [{ at: new Date(), action: "seeded", after: card }],
    });
    console.log(`Created rate card ${saved._id}.`);
  }
} finally {
  await mongoose.disconnect();
}
