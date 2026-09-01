const DAY_MS = 24 * 60 * 60 * 1000;

const normalizeName = (value = "") =>
  String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

const DEFAULT_REGENERATION_RULES = [
  { aliases: ["auto25"], intervalUnit: "month", intervalValue: 1 },
  { aliases: ["auto40"], intervalUnit: "month", intervalValue: 1 },
  { aliases: ["auto100l", "auto100litre", "auto100liter"], intervalUnit: "month", intervalValue: 1 },
  { aliases: ["autosandfilter"], intervalUnit: "month", intervalValue: 1 },
  { aliases: ["bathroomwatersoftener"], intervalUnit: "week", intervalValue: 1 },
];

export const parseInvoicePurchaseDate = (invoice) => {
  const value = invoice?.date || invoice?.createdAt;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = String(value || "").trim();
  const indianDate = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (indianDate) {
    const [, day, month, year] = indianDate;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const resolveRegenerationPolicy = (product = {}, invoiceProduct = {}) => {
  const configured = product?.reminderPolicy?.regeneration;
  if (configured?.enabled && configured.intervalUnit && configured.intervalValue > 0) {
    return {
      intervalUnit: configured.intervalUnit,
      intervalValue: Number(configured.intervalValue),
    };
  }
  const candidate = normalizeName(
    product.title || product.ShortName || invoiceProduct.productName,
  );
  return (
    DEFAULT_REGENERATION_RULES.find((rule) =>
      rule.aliases.some((alias) => candidate.includes(alias)),
    ) || null
  );
};

const addInterval = (date, unit, amount) => {
  const result = new Date(date);
  if (unit === "week") result.setUTCDate(result.getUTCDate() + amount * 7);
  else result.setUTCMonth(result.getUTCMonth() + amount);
  return result;
};

export const getNextDueDate = (purchaseDate, unit, amount, now = new Date()) => {
  let due = addInterval(purchaseDate, unit, amount);
  while (due <= now) due = addInterval(due, unit, amount);
  return due;
};

export const getCurrentDueDate = (purchaseDate, unit, amount, now = new Date()) => {
  let due = addInterval(purchaseDate, unit, amount);
  let previous = null;
  while (due <= now) {
    previous = due;
    due = addInterval(due, unit, amount);
  }
  return previous;
};

export const getAnnualDueDates = (purchaseDate, now = new Date()) => ({
  current: getCurrentDueDate(purchaseDate, "month", 12, now),
  next: getNextDueDate(purchaseDate, "month", 12, now),
});

export const getWarrantyDates = (purchaseDate, warrantyMonths = 12) => {
  const expiresAt = addInterval(purchaseDate, "month", warrantyMonths);
  const reminderAt = new Date(expiresAt);
  reminderAt.setUTCDate(reminderAt.getUTCDate() - 30);
  return { expiresAt, reminderAt };
};

export const isDueWithinGrace = (dueDate, now, graceDays = 2) =>
  Boolean(dueDate) && now >= dueDate && now.getTime() - dueDate.getTime() <= graceDays * DAY_MS;

export const buildReminderDedupeKey = ({ invoiceId, productKey, type, dueDate }) =>
  `${invoiceId}:${productKey}:${type}:${dueDate.toISOString().slice(0, 10)}`;
