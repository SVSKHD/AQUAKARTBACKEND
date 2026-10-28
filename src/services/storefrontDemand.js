import AquaInvoice from "../models/crm/invoice.js";

// Public "people near you bought…" feed built from invoices. Only product
// details, a coarse locality and an hour-rounded time leave this module: no
// customer names, phones, emails, invoice numbers or full addresses.

export const DEMAND_DEFAULTS = { limit: 10, days: 30, trending: 5 };
const MAX_LIMIT = 20;
const MAX_DAYS = 90;
const MAX_AREA_LENGTH = 60;

// Segments that name the city/state/country rather than the locality.
const REGION_WORDS = new Set([
  "hyderabad",
  "secunderabad",
  "telangana",
  "india",
  "andhra pradesh",
  "ap",
  "ts",
  "tg",
  "rangareddy",
  "ranga reddy",
  "rangareddy district",
  "medchal",
  "medchal malkajgiri",
  "sangareddy",
  "hyderabad district",
]);
const CITIES = ["Hyderabad", "Secunderabad"];

const clampInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const titleCase = (value) =>
  value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

export const parseDemandQuery = (query = {}) => {
  const area = String(query.area || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AREA_LENGTH);
  return {
    area,
    limit: clampInt(query.limit, DEMAND_DEFAULTS.limit, 1, MAX_LIMIT),
    days: clampInt(query.days, DEMAND_DEFAULTS.days, 1, MAX_DAYS),
  };
};

// "Flat 4, Lake View Apts, Kondapur, Hyderabad, Telangana 500084" -> "Kondapur".
// Falls back to the city when no locality can be picked out, else null.
export const areaFromAddress = (address) => {
  const text = String(address || "");
  const segments = text
    .split(/[,\n]/)
    .map((s) =>
      s
        .replace(/\b\d{3}\s?\d{3}\b/g, "") // PIN codes
        .replace(/\s+/g, " ")
        .replace(/^[\s\-.:]+|[\s\-.:]+$/g, ""),
    )
    .filter(Boolean)
    .filter((s) => !REGION_WORDS.has(s.toLowerCase()));
  const locality = segments[segments.length - 1];
  // Skip house numbers, plot/flat lines and long free text.
  if (
    locality &&
    locality.length <= 30 &&
    /[a-z]/i.test(locality) &&
    !/\d/.test(locality) &&
    !/\b(flat|plot|h\.?\s?no|door|floor|road no|street no)\b/i.test(locality)
  )
    return titleCase(locality);
  const city = CITIES.find((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
  return city || null;
};

const toHour = (value) => {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

const productKey = (p) =>
  p.productId
    ? `id:${p.productId}`
    : `name:${String(p.productName || "")
        .trim()
        .toLowerCase()}`;

const cleanName = (name) =>
  String(name || "")
    .replace(/\s+/g, " ")
    .trim();

const buildMatch = ({ area, days }, now) => {
  const match = {
    quotation: { $ne: true },
    createdAt: { $gte: new Date(now.getTime() - days * 86400000) },
    "products.productName": { $exists: true, $ne: "" },
  };
  if (area)
    match["customerDetails.address"] = {
      $regex: escapeRegex(area),
      $options: "i",
    };
  return match;
};

// Latest purchased lines (newest first) plus the most-bought products in the window.
export const getRecentDemand = async (options, now = new Date()) => {
  const { area, limit, days } = options;
  const match = buildMatch({ area, days }, now);

  const [invoices, trendingRows] = await Promise.all([
    AquaInvoice.find(match)
      .select("createdAt customerDetails.address products")
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .maxTimeMS(5000)
      .lean(),
    AquaInvoice.aggregate([
      { $match: match },
      { $unwind: "$products" },
      { $match: { "products.productName": { $exists: true, $ne: "" } } },
      {
        $group: {
          _id: {
            $ifNull: [
              { $toString: "$products.productId" },
              { $toLower: { $trim: { input: "$products.productName" } } },
            ],
          },
          productName: { $last: "$products.productName" },
          productSlug: { $last: "$products.productSlug" },
          productId: { $last: "$products.productId" },
          orders: { $addToSet: "$_id" },
          units: { $sum: { $ifNull: ["$products.productQuantity", 1] } },
          lastPurchasedAt: { $max: "$createdAt" },
        },
      },
      {
        $project: {
          productName: 1,
          productSlug: 1,
          productId: 1,
          units: 1,
          lastPurchasedAt: 1,
          orders: { $size: "$orders" },
        },
      },
      { $sort: { orders: -1, units: -1, lastPurchasedAt: -1 } },
      { $limit: DEMAND_DEFAULTS.trending },
    ]).option({ maxTimeMS: 5000 }),
  ]);

  const recent = [];
  for (const inv of invoices) {
    const where = area
      ? titleCase(area)
      : areaFromAddress(inv.customerDetails?.address);
    const seen = new Set();
    for (const p of inv.products || []) {
      const name = cleanName(p.productName);
      if (!name || seen.has(productKey(p))) continue;
      seen.add(productKey(p));
      recent.push({
        productName: name,
        productSlug: p.productSlug || null,
        productId: p.productId ? String(p.productId) : null,
        quantity: Math.max(1, Number(p.productQuantity) || 1),
        area: where,
        purchasedAt: toHour(inv.createdAt),
      });
      if (recent.length >= limit) break;
    }
    if (recent.length >= limit) break;
  }

  const trending = trendingRows.map((row) => ({
    productName: cleanName(row.productName),
    productSlug: row.productSlug || null,
    productId: row.productId ? String(row.productId) : null,
    orders: row.orders,
    units: row.units,
    lastPurchasedAt: toHour(row.lastPurchasedAt),
  }));

  return { area: area ? titleCase(area) : null, days, recent, trending };
};
