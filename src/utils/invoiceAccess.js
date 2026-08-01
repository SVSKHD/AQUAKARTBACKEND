import crypto from "crypto";
import jwt from "jsonwebtoken";

export const normalizeIndianPhone = (value = "") => {
  const digits = String(value).replace(/\D/g, "");
  const normalized =
    digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(normalized) ? normalized : "";
};

export const normalizeEmail = (value = "") =>
  String(value).trim().toLowerCase();

export const maskEmail = (value = "") => {
  const email = normalizeEmail(value);
  const [local, domain] = email.split("@");
  if (!local || !domain) return "";
  const [domainName, ...suffix] = domain.split(".");
  const visibleLocal = local.slice(0, Math.min(2, local.length));
  const visibleDomain = domainName.slice(0, 1);
  return `${visibleLocal}${"*".repeat(Math.max(3, local.length - visibleLocal.length))}@${visibleDomain}***${suffix.length ? `.${suffix.join(".")}` : ""}`;
};

export const createOpaqueToken = () => crypto.randomBytes(32).toString("hex");
export const hashToken = (token = "") =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const accessSecret = () => {
  const secret = process.env.INVOICE_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    const error = new Error("Invoice access is not configured");
    error.statusCode = 503;
    throw error;
  }
  return secret;
};

export const signInvoiceAccessToken = ({ invoiceIds, email, firebaseUid }) =>
  jwt.sign(
    {
      purpose: "invoice-access",
      invoiceIds: invoiceIds.map(String),
      email: normalizeEmail(email),
      firebaseUid: firebaseUid || undefined,
    },
    accessSecret(),
    { expiresIn: process.env.INVOICE_ACCESS_SESSION_EXPIRY || "30m" },
  );

export const verifyInvoiceAccessToken = (token) => {
  const payload = jwt.verify(token, accessSecret());
  if (
    payload?.purpose !== "invoice-access" ||
    !Array.isArray(payload.invoiceIds)
  ) {
    throw new Error("Invalid invoice access token");
  }
  return payload;
};

export const calculateInvoiceTotal = (invoice = {}) =>
  (invoice.products || []).reduce(
    (total, product) =>
      total +
      Number(product?.productPrice || 0) *
        Number(product?.productQuantity || 0),
    0,
  );
