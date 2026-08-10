import AquaEcomUser from "../models/user.js";
import { normalizeIndianPhone, validateEmail } from "../utils/invoiceAccess.js";

const splitName = (name = "") => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
};

const invoiceDate = (invoice = {}) => {
  const value = invoice.createdAt || invoice.date;
  const parsed = new Date(value || 0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
};

export const buildInvoiceProfile = (invoices = []) => {
  const ordered = [...invoices]
    .filter(Boolean)
    .sort((left, right) => invoiceDate(right) - invoiceDate(left));
  const invoiceWithName = ordered.find((invoice) =>
    String(invoice.customerDetails?.name || "").trim(),
  );
  const invoiceWithPhone = ordered.find((invoice) =>
    normalizeIndianPhone(invoice.customerDetails?.phone),
  );
  const invoiceWithAddress = ordered.find((invoice) =>
    String(invoice.customerDetails?.address || "").trim(),
  );

  return {
    ...splitName(invoiceWithName?.customerDetails?.name),
    phone: normalizeIndianPhone(invoiceWithPhone?.customerDetails?.phone),
    address: String(invoiceWithAddress?.customerDetails?.address || "").trim(),
    invoices: ordered.map((invoice) => ({
      invoiceId: invoice._id,
      invoiceNo: String(invoice.invoiceNo || "").trim(),
    })),
  };
};

const findOrCreateGoogleUser = async (firebaseUser, now) => {
  const email = validateEmail(firebaseUser.email);
  let user = await AquaEcomUser.findOne({
    $or: [{ firebaseUid: firebaseUser.uid }, { email }],
  });

  if (user?.firebaseUid && user.firebaseUid !== firebaseUser.uid) {
    const error = new Error("This email is linked to another Google account");
    error.statusCode = 409;
    throw error;
  }

  if (user) return user;

  const names = splitName(firebaseUser.name);
  try {
    return await AquaEcomUser.create({
      firebaseUid: firebaseUser.uid,
      email,
      authProvider: "google.com",
      isGoogleLogin: true,
      isEmailVerfied: Boolean(firebaseUser.emailVerified),
      emailVerified: Boolean(firebaseUser.emailVerified),
      firstName: names.firstName,
      lastName: names.lastName,
      photoURL: firebaseUser.picture,
      firstLoginAt: now,
      lastLoginAt: now,
      loginCount: 1,
      googleData: {
        uid: firebaseUser.uid,
        email,
        picture: firebaseUser.picture,
      },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    user = await AquaEcomUser.findOne({
      $or: [{ firebaseUid: firebaseUser.uid }, { email }],
    });
    if (!user) throw error;
    return user;
  }
};

export const enrichUserFromInvoices = async ({
  firebaseUser,
  invoices = [],
}) => {
  if (!firebaseUser?.uid || !validateEmail(firebaseUser.email)) return null;

  const now = new Date();
  const user = await findOrCreateGoogleUser(firebaseUser, now);
  const profile = buildInvoiceProfile(invoices);

  user.firebaseUid ||= firebaseUser.uid;
  user.isGoogleLogin = true;
  user.authProvider = "google.com";
  user.emailVerified ||= Boolean(firebaseUser.emailVerified);
  user.isEmailVerfied ||= Boolean(firebaseUser.emailVerified);
  user.firstName ||= profile.firstName;
  user.lastName ||= profile.lastName;
  user.photoURL ||= firebaseUser.picture;

  if (!user.phone && profile.phone) {
    const phoneOwner = await AquaEcomUser.exists({
      phone: Number(profile.phone),
      _id: { $ne: user._id },
    });
    if (!phoneOwner) user.phone = Number(profile.phone);
  }

  if (!user.selectedAddress?.street && profile.address) {
    user.selectedAddress = { street: profile.address };
  }
  if (
    profile.address &&
    !user.addresses.some(
      (address) =>
        String(address.street || "")
          .trim()
          .toLowerCase() === profile.address.toLowerCase(),
    )
  ) {
    user.addresses.push({ street: profile.address });
  }

  const linkedIds = new Set(
    user.invoices.map((entry) => String(entry.invoiceId)),
  );
  for (const invoice of profile.invoices) {
    if (!linkedIds.has(String(invoice.invoiceId))) {
      user.invoices.push({ ...invoice, linkedAt: now });
      linkedIds.add(String(invoice.invoiceId));
    }
  }

  user.invoiceProfileEnrichedAt = now;
  await user.save();
  return user;
};
