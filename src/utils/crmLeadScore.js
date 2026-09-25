const STATUS_POINTS = {
  new: 0,
  contacted: 5,
  qualified: 10,
  water_details: 15,
  site_visit: 25,
  recommended: 30,
  quote_sent: 35,
  follow_up: 30,
  won: 60,
  lost: 0,
};

const SOURCE_POINTS = {
  planner: 10,
  whatsapp: 10,
  website: 8,
  referral: 8,
  apartment: 8,
  "google ads": 8,
  google: 6,
  instagram: 6,
  tradeindia: 5,
};

const normalize = (value) => String(value || "").trim().toLowerCase();

const known = (value, unknownValues = ["", "unknown"]) =>
  !unknownValues.includes(normalize(value));

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getHardnessPoints = (qualification = {}) => {
  const ppm = numberValue(qualification.hardness_ppm);
  if (ppm >= 300) return 12;
  if (ppm >= 150) return 8;
  if (ppm > 0) return 4;

  const level = normalize(qualification.hardness_level);
  if (level === "very_hard") return 10;
  if (level === "hard") return 7;
  if (level === "mild") return 3;
  return 0;
};

const getUrgencyPoints = (urgency) => {
  const value = normalize(urgency);
  if (value === "immediate") return 15;
  if (value === "7_days") return 10;
  if (value === "30_days") return 6;
  if (value === "researching") return 2;
  return 0;
};

const getInterestPoints = (interest) => {
  const value = normalize(interest);
  if (value === "automatic" || value === "whole_house") return 10;
  if (value === "manual" || value === "bathroom") return 6;
  return 0;
};

const getFollowUpPoints = (lead, now) => {
  if (!lead?.next_follow_up) return 0;
  const date = new Date(lead.next_follow_up);
  if (Number.isNaN(date.getTime())) return 0;
  return date.getTime() >= now.getTime() ? 5 : -5;
};

const calculateLeadScore = (lead = {}, now = new Date()) => {
  if (normalize(lead.status) === "won") {
    return {
      score: 100,
      band: "hot",
      breakdown: { converted: 100 },
    };
  }

  if (normalize(lead.status) === "lost") {
    return {
      score: 0,
      band: "cold",
      breakdown: { lost: 0 },
    };
  }

  const qualification = lead.qualification || {};
  const source = normalize(lead.source);

  const breakdown = {
    pipeline: STATUS_POINTS[normalize(lead.status)] || 0,
    contact: (lead.phone ? 4 : 0) + (lead.email ? 2 : 0),
    source: SOURCE_POINTS[source] || 0,
    water_source: known(qualification.water_source) ? 4 : 0,
    hardness: getHardnessPoints(qualification),
    household:
      (numberValue(qualification.residents) > 0 ? 3 : 0) +
      (numberValue(qualification.bathrooms) > 0 ? 3 : 0),
    product_interest: getInterestPoints(qualification.product_interest),
    budget:
      numberValue(qualification.budget_min) > 0 ||
      numberValue(qualification.budget_max) > 0
        ? 6
        : 0,
    urgency: getUrgencyPoints(qualification.urgency),
    location:
      qualification.locality && qualification.pincode
        ? 4
        : qualification.locality || qualification.pincode
          ? 2
          : 0,
    recommendation:
      qualification.recommended_product_id ||
      numberValue(qualification.recommended_capacity_liters) > 0
        ? 5
        : 0,
    follow_up: getFollowUpPoints(lead, now),
  };

  const rawScore = Object.values(breakdown).reduce(
    (sum, points) => sum + numberValue(points),
    0,
  );
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const band = score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";

  return { score, band, breakdown };
};

export { calculateLeadScore };
