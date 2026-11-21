import crypto from "node:crypto";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";

// Pure helpers for offline payment links: tokens, snapshots, validation and
// mapping. No database access.

export class OfflinePaymentError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// One message for unknown, revoked, expired, outdated and unpayable links so
// a token can't be probed for its state.
export const LINK_UNAVAILABLE = () =>
  new OfflinePaymentError(
    404,
    "LINK_UNAVAILABLE",
    "This payment link is invalid or has expired. Please contact Aquakart for a new link.",
  );

export const createLinkToken = () =>
  crypto.randomBytes(32).toString("base64url");
export const hashLinkToken = (token) =>
  crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// The token is also kept sealed (AES-256-GCM) so staff can re-send the same
// link from the CRM. Lookup still uses only the hash. The key is derived from
// PAYMENT_LINK_TOKEN_KEY (or JWT_SECRET); without a key nothing is sealed and
// re-sending is unavailable.
export const deriveLinkTokenKey = (secret) =>
  secret
    ? crypto
        .createHash("sha256")
        .update(`aquakart:payment-link-token:${secret}`)
        .digest()
    : null;
export const sealLinkToken = (token, key) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    sealed.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
};
export const openLinkToken = (value, key) => {
  try {
    const [version, iv, sealed, tag] = String(value || "").split(".");
    if (version !== "v1" || !key) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const token = Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch (_error) {
    return null;
  }
};

export const toPaise = (value) => Math.round(Number(value || 0) * 100);
export const money = (value) => toPaise(value) / 100;

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
};

// Everything that decides what the customer pays. Any change after the
// link was created makes the link invalid.
export const snapshotHash = (snapshot) =>
  crypto
    .createHash("sha256")
    .update(
      stable({
        lines: snapshot.lines.map((line) => ({
          productId: line.productId || null,
          name: line.name,
          quantity: Number(line.quantity) || 0,
          price: toPaise(line.price),
          discount: toPaise(line.discount),
          tax: toPaise(line.tax),
        })),
        subTotal: toPaise(snapshot.subTotal),
        discount: toPaise(snapshot.discount),
        tax: toPaise(snapshot.tax),
        total: toPaise(snapshot.total),
        currency: snapshot.currency,
      }),
    )
    .digest("hex");

const text = (value) => String(value ?? "").trim();

// Customer address from the payment page: street, city, state, 6-digit
// Indian pincode (first digit 1-9).
export const PINCODE = /^[1-9]\d{5}$/;
export const validateCustomerDetails = (body = {}) => {
  const errors = {};
  const address = body.address || {};
  const value = {
    street: text(address.street).slice(0, 300),
    city: text(address.city).slice(0, 80),
    state: text(address.state).slice(0, 80),
    postalCode: text(address.postalCode).replace(/\s/g, ""),
  };
  if (value.street.length < 5)
    errors["address.street"] =
      "Enter the house/flat and street (at least 5 characters)";
  if (value.city.length < 2) errors["address.city"] = "City is required";
  if (value.state.length < 2) errors["address.state"] = "State is required";
  if (!PINCODE.test(value.postalCode))
    errors["address.postalCode"] = "Enter a valid 6-digit pincode";
  let alternatePhone = null;
  if (body.alternatePhone !== undefined && text(body.alternatePhone) !== "") {
    alternatePhone = normalizeIndianPhone(body.alternatePhone);
    if (!alternatePhone)
      errors.alternatePhone = "Enter a valid 10-digit Indian mobile number";
  }
  if (Object.keys(errors).length)
    throw new OfflinePaymentError(
      400,
      "VALIDATION_FAILED",
      "Please check the highlighted details",
      errors,
    );
  return { address: value, alternatePhone };
};

export const formatAddress = (address = {}) =>
  [address.street, address.city, address.state, address.postalCode]
    .map(text)
    .filter(Boolean)
    .join(", ");

export const sameAddress = (a = {}, b = {}) =>
  ["street", "city", "state", "postalCode"].every(
    (key) => text(a[key]).toLowerCase() === text(b[key]).toLowerCase(),
  );

// PhonePe paymentInstrument.type -> invoice paymentType / quotation mode.
export const paymentModes = (instrumentType) => {
  const type = String(instrumentType || "").toUpperCase();
  if (type.startsWith("UPI")) return { invoice: "upi", document: "UPI" };
  if (type.includes("CARD")) return { invoice: "card", document: "Card" };
  // v1 says NETBANKING, v2 NET_BANKING.
  if (type === "NETBANKING" || type === "NET_BANKING")
    return { invoice: "bank_transfer", document: "Bank Transfer" };
  return { invoice: "online", document: "Other" };
};

export const isStockError = (error) =>
  /stock/i.test(String(error?.message || "")) &&
  Number(error?.statusCode || error?.status) === 400;
