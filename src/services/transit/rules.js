import crypto from "node:crypto";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";

// Pure Transit rules: pricing tiers, payout and customer payment arithmetic,
// input validation and snapshot hashing. No database, no network. Every
// amount here is computed in code; Gemini never decides a charge or a status.

export class TransitError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const MAX_TIERS = 20;
export const MAX_ITEMS = 20;
export const MAX_QUANTITY = 1000;
// A price this far from the catalog price is flagged (not blocked).
export const PRICE_DRIFT_WARNING = 0.15;
const EPSILON = 0.005;

export const money = (value) => Math.round(Number(value) * 100) / 100;
export const km = (meters) => Math.round(Number(meters) / 10) / 100;

const finite = (value) =>
  value !== null && value !== "" && Number.isFinite(Number(value));

// ---- Pricing tiers ------------------------------------------------------------

/**
 * Tiers must start at 0 km, follow each other without gaps or overlaps, and
 * end with one open tier (maxKm null) so every distance has a price.
 * Returns { tiers (normalised, sorted), errors }.
 */
export const validateTiers = (input) => {
  const errors = [];
  if (!Array.isArray(input) || !input.length) {
    return { tiers: [], errors: ["At least one tier is required"] };
  }
  if (input.length > MAX_TIERS)
    return { tiers: [], errors: [`At most ${MAX_TIERS} tiers`] };
  const tiers = input.map((tier, index) => {
    const minKm = Number(tier?.minKm);
    const open =
      tier?.maxKm === null || tier?.maxKm === undefined || tier?.maxKm === "";
    const maxKm = open ? null : Number(tier.maxKm);
    const price = Number(tier?.price);
    if (!finite(tier?.minKm) || minKm < 0)
      errors.push(`Tier ${index + 1}: minKm must be 0 or more`);
    if (!open && (!Number.isFinite(maxKm) || maxKm <= minKm))
      errors.push(`Tier ${index + 1}: maxKm must be greater than minKm`);
    if (!finite(tier?.price) || price < 0)
      errors.push(`Tier ${index + 1}: price must be 0 or more`);
    return { minKm, maxKm, price: money(price) };
  });
  if (errors.length) return { tiers: [], errors };
  tiers.sort((a, b) => a.minKm - b.minKm);
  if (tiers[0].minKm !== 0) errors.push("The first tier must start at 0 km");
  tiers.forEach((tier, index) => {
    const last = index === tiers.length - 1;
    if (!last && tier.maxKm === null)
      errors.push(
        `Only the last tier can be open-ended (tier from ${tier.minKm} km)`,
      );
    if (last && tier.maxKm !== null)
      errors.push(
        `The last tier must be open-ended so distances above ${tier.maxKm} km have a price`,
      );
    const next = tiers[index + 1];
    if (next && tier.maxKm !== null && next.minKm !== tier.maxKm)
      errors.push(
        next.minKm > tier.maxKm
          ? `Gap between ${tier.maxKm} km and ${next.minKm} km`
          : `Tiers overlap between ${next.minKm} km and ${tier.maxKm} km`,
      );
  });
  return { tiers: errors.length ? [] : tiers, errors };
};

/**
 * The tier for a distance. A tier covers (minKm, maxKm]; the first also
 * covers 0. So with 0-10 / 10-15 / 15+: 10.00 km is tier 1, 10.01 km tier 2.
 */
export const tierForDistance = (tiers, distanceKm) => {
  const distance = Math.round(Number(distanceKm) * 100) / 100;
  if (!Number.isFinite(distance) || distance < 0) return null;
  return (
    tiers.find((tier) => tier.maxKm === null || distance <= tier.maxKm) || null
  );
};

/** The rate card in force at `at`: active, started, not ended, latest start. */
export const currentRateCard = (cards = [], at = new Date()) =>
  cards
    .filter(
      (card) =>
        card.status === "active" &&
        new Date(card.effectiveFrom) <= at &&
        (!card.effectiveTo || new Date(card.effectiveTo) > at),
    )
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))[0] ||
  null;

export const validateRateCardInput = (body = {}, now = new Date()) => {
  const errors = [];
  const name = String(body.name || "")
    .trim()
    .slice(0, 120);
  if (!name) errors.push("name is required");
  const { tiers, errors: tierErrors } = validateTiers(body.tiers);
  errors.push(...tierErrors);
  const cashIncentive = Number(body.cashIncentive);
  if (!finite(body.cashIncentive) || cashIncentive < 0)
    errors.push("cashIncentive must be 0 or more");
  const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : now;
  if (Number.isNaN(effectiveFrom.getTime()))
    errors.push("effectiveFrom must be a date");
  const effectiveTo = body.effectiveTo ? new Date(body.effectiveTo) : null;
  if (
    effectiveTo &&
    (Number.isNaN(effectiveTo.getTime()) || effectiveTo <= effectiveFrom)
  )
    errors.push("effectiveTo must be after effectiveFrom");
  if (errors.length)
    throw new TransitError(
      400,
      "INVALID_RATE_CARD",
      "Invalid rate card",
      errors,
    );
  return {
    name,
    tiers,
    cashIncentive: money(cashIncentive),
    effectiveFrom,
    effectiveTo,
  };
};

export const priceSnapshot = (card, distanceKm) => {
  if (!card)
    throw new TransitError(
      503,
      "PRICING_NOT_CONFIGURED",
      "No transport rate card is in force. An admin must add one.",
    );
  const tier = tierForDistance(card.tiers, distanceKm);
  if (!tier)
    throw new TransitError(
      503,
      "PRICING_NOT_CONFIGURED",
      "The rate card has no tier for this distance",
    );
  return {
    rateCardId: card._id,
    rateCardName: card.name,
    tier: { minKm: tier.minKm, maxKm: tier.maxKm, price: tier.price },
    baseCharge: money(tier.price),
    cashIncentive: money(card.cashIncentive),
    currency: card.currency || "INR",
  };
};

// ---- Payout and customer payment ------------------------------------------------

export const payoutTotals = ({
  baseCharge,
  cashIncentive,
  incentiveAwarded,
}) => {
  const incentive = incentiveAwarded ? money(cashIncentive) : 0;
  return {
    baseCharge: money(baseCharge),
    cashIncentive: incentive,
    totalPayable: money(Number(baseCharge) + incentive),
  };
};

const COUNTED = ["cash_confirmed", "admin_verified", "provider_verified"];

/** Customer payment summary from the collections (exception = admin override). */
export const paymentSummary = ({ amountDue, collections = [], exception }) => {
  const sum = (filter) =>
    money(
      collections
        .filter(filter)
        .reduce((total, entry) => total + Number(entry.amount || 0), 0),
    );
  const amountConfirmed = sum((entry) => COUNTED.includes(entry.verification));
  const amountPendingVerification = sum(
    (entry) => entry.verification === "transporter_reported",
  );
  const covered = amountConfirmed + EPSILON >= Number(amountDue);
  return {
    status: covered || exception?.reason ? "paid" : "unpaid",
    amountConfirmed,
    amountPendingVerification,
    balance: money(Math.max(0, Number(amountDue) - amountConfirmed)),
  };
};

/** The invoice's existing paidStatus value for a payment summary. */
export const invoicePaidStatus = (summary) =>
  summary.status === "paid"
    ? "paid"
    : summary.amountConfirmed > 0
      ? "partial"
      : "unpaid";

export const verificationForMethod = (method) =>
  method === "cash" ? "cash_confirmed" : "transporter_reported";

// ---- Input validation ---------------------------------------------------------

const text = (value, max = 300) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export const validLatLng = (point) =>
  point &&
  finite(point.lat) &&
  finite(point.lng) &&
  Number(point.lat) >= -90 &&
  Number(point.lat) <= 90 &&
  Number(point.lng) >= -180 &&
  Number(point.lng) <= 180;

/**
 * The confirmed submission a transporter sends after reviewing the parsed
 * text. Product names and catalog prices come from the database, not from
 * here. Throws TransitError 400 with field errors.
 */
export const validateSubmission = (body = {}) => {
  const errors = [];
  const customer = body.customer || {};
  const name = text(customer.name, 120);
  if (!name)
    errors.push({
      field: "customer.name",
      message: "Customer name is required",
    });
  const phone = normalizeIndianPhone(customer.phone);
  if (!phone)
    errors.push({
      field: "customer.phone",
      message: "A valid 10-digit Indian mobile number is required",
    });
  const email = text(customer.email, 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.push({ field: "customer.email", message: "Email is not valid" });
  const address = text(customer.address, 500);
  if (address.length < 5)
    errors.push({
      field: "customer.address",
      message: "Delivery address is required",
    });

  const rows = Array.isArray(body.items) ? body.items : [];
  if (!rows.length)
    errors.push({
      field: "items",
      message: "At least one product is required",
    });
  if (rows.length > MAX_ITEMS)
    errors.push({ field: "items", message: `At most ${MAX_ITEMS} products` });
  const items = rows.slice(0, MAX_ITEMS).map((row, index) => {
    const field = `items.${index + 1}`;
    const productId = String(row?.productId || "");
    if (!/^[a-f0-9]{24}$/i.test(productId))
      errors.push({
        field: `${field}.productId`,
        message: "Choose a catalog product",
      });
    const quantity = Number(row?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)
      errors.push({
        field: `${field}.quantity`,
        message: `Quantity must be a whole number from 1 to ${MAX_QUANTITY}`,
      });
    const unitPrice = Number(row?.unitPrice);
    if (!finite(row?.unitPrice) || unitPrice <= 0)
      errors.push({
        field: `${field}.unitPrice`,
        message: "Selling price is required",
      });
    return {
      productId,
      quantity,
      unitPrice: money(unitPrice),
      serialNo: text(row?.serialNo, 100),
    };
  });

  let destination = null;
  if (body.destination !== undefined && body.destination !== null) {
    if (!validLatLng(body.destination))
      errors.push({
        field: "destination",
        message: "Pinned location is not valid",
      });
    else
      destination = {
        lat: Number(body.destination.lat),
        lng: Number(body.destination.lng),
      };
  }
  const expected = body.expectedTransportCharge;
  if (expected !== undefined && expected !== null && !finite(expected))
    errors.push({
      field: "expectedTransportCharge",
      message: "expectedTransportCharge must be a number",
    });

  if (errors.length)
    throw new TransitError(
      400,
      "VALIDATION_FAILED",
      "Please correct the highlighted details",
      errors,
    );
  return {
    customer: { name, phone, email, address },
    items,
    destination,
    expectedTransportCharge:
      expected === undefined || expected === null ? null : money(expected),
  };
};

/** Checks the items against catalog products; returns priced lines + warnings. */
export const priceItems = (items, products) => {
  const byId = new Map(
    products.map((product) => [String(product.productId), product]),
  );
  const errors = [];
  const warnings = [];
  const lines = items.map((item, index) => {
    const product = byId.get(item.productId);
    if (!product) {
      errors.push({
        field: `items.${index + 1}.productId`,
        message: "This product is not in the catalog",
      });
      return null;
    }
    const catalogPrice = finite(product.sellingPrice)
      ? money(product.sellingPrice)
      : null;
    if (
      catalogPrice &&
      Math.abs(item.unitPrice - catalogPrice) / catalogPrice >
        PRICE_DRIFT_WARNING
    )
      warnings.push({
        field: `items.${index + 1}.unitPrice`,
        message: `${product.name}: selling price ₹${item.unitPrice} differs from the catalog price ₹${catalogPrice} by more than ${PRICE_DRIFT_WARNING * 100}%`,
      });
    return {
      productId: item.productId,
      productName: product.name,
      productSlug: product.slug || "",
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      catalogPrice,
      serialNo: item.serialNo,
    };
  });
  if (errors.length)
    throw new TransitError(
      400,
      "VALIDATION_FAILED",
      "Some products were not found",
      errors,
    );
  const invoiceTotal = money(
    lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0),
  );
  return { lines, invoiceTotal, warnings };
};

// ---- Hashing ------------------------------------------------------------------

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
};

export const hashOf = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

/** Request hash: what the transporter confirmed (not the computed route). */
export const requestHash = (submission) =>
  hashOf({
    customer: submission.customer,
    items: submission.items,
    destination: submission.destination,
  });

export const snapshotHash = (delivery, pricing) =>
  hashOf({ delivery, pricing });
