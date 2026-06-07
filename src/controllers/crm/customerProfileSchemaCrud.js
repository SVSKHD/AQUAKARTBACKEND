import mongoose from "mongoose";
import BaseCustomerProfileOperations from "./customerProfile.js";
import AquaEcomUser from "../../models/user.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const normalizeEmail = (email) => {
  const value = String(email || "").trim().toLowerCase();
  return value || undefined;
};

const normalizePhone = (phone) =>
  String(phone || "")
    .replace(/\s|-/g, "")
    .replace(/^\+91/, "")
    .replace(/^91/, "")
    .trim();

const toPhoneValue = (phone) => {
  const normalized = normalizePhone(phone);
  if (!normalized) return undefined;
  const asNumber = Number(normalized);
  return Number.isNaN(asNumber) ? undefined : asNumber;
};

const splitName = (name = "") => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
};

const sanitizeAddress = (address = {}) => {
  if (typeof address === "string") {
    return { street: address, city: "", state: "", postalCode: "" };
  }

  return {
    street:
      address.street ||
      address.address ||
      address.line1 ||
      address.addressLine1 ||
      address.fullAddress ||
      "",
    city: address.city || "",
    state: address.state || "",
    postalCode: address.postalCode || address.pincode || address.pinCode || address.zip || "",
  };
};

const pickDefined = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const buildOnlineUserPayload = (body = {}, mode = "update") => {
  const source = { ...body };

  // Keep CRM CRUD aligned to AquaEcomUser schema. The frontend may still send legacy
  // convenience keys like name/address, so map them to firstName/lastName/selectedAddress.
  const nameParts = source.name ? splitName(source.name) : {};
  const email = source.email !== undefined ? normalizeEmail(source.email) : undefined;
  const alternativeEmail =
    source.alternativeEmail !== undefined ? normalizeEmail(source.alternativeEmail) : undefined;
  const phone = source.phone !== undefined ? toPhoneValue(source.phone) : undefined;

  const selectedAddress =
    source.selectedAddress !== undefined
      ? sanitizeAddress(source.selectedAddress)
      : source.address !== undefined
        ? sanitizeAddress(source.address)
        : undefined;

  const addresses = Array.isArray(source.addresses)
    ? source.addresses.map(sanitizeAddress)
    : undefined;

  const gstDetails = source.gstDetails
    ? pickDefined({
        gstEmail:
          source.gstDetails.gstEmail !== undefined
            ? normalizeEmail(source.gstDetails.gstEmail)
            : undefined,
        gstNo: source.gstDetails.gstNo,
        gstPhone:
          source.gstDetails.gstPhone !== undefined
            ? toPhoneValue(source.gstDetails.gstPhone)
            : undefined,
        gstAddres: source.gstDetails.gstAddres,
      })
    : undefined;

  const payload = pickDefined({
    firstName: source.firstName ?? nameParts.firstName,
    lastName: source.lastName ?? nameParts.lastName,
    email,
    phone,
    alternativeEmail,
    dob: source.dob || undefined,
    role: source.role !== undefined && source.role !== "" ? Number(source.role) : undefined,
    isEmailVerfied:
      source.isEmailVerfied !== undefined ? Boolean(source.isEmailVerfied) : undefined,
    ismobileLoginConfirmation:
      source.ismobileLoginConfirmation !== undefined
        ? Boolean(source.ismobileLoginConfirmation)
        : undefined,
    gstDetails,
    selectedAddress,
    addresses,
  });

  if (mode === "create") {
    payload.role = payload.role ?? 2;
    payload.userSignedupDate = source.userSignedupDate || new Date();
  }

  payload.lastDetailsUpdatedDate = new Date();
  payload.profileUpdated = new Date();

  return payload;
};

const createOnlineProfile = async (req, res) => {
  try {
    const payload = buildOnlineUserPayload(req.body, "create");

    if (!payload.email && !payload.phone) {
      return res.status(400).json({ success: false, message: "Email or phone is required" });
    }

    const created = await AquaEcomUser.create(payload);
    const data = await AquaEcomUser.findById(created._id).select("-password").lean();
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("CRM schema createOnlineProfile error:", error);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "Duplicate email or phone" });
    }
    return res.status(500).json({ success: false, message: error.message || "Server error" });
  }
};

const updateOnlineProfile = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid customer id" });
    }

    const payload = buildOnlineUserPayload(req.body, "update");
    delete payload.userSignedupDate;

    const updated = await AquaEcomUser.findByIdAndUpdate(
      id,
      { $set: payload },
      { new: true, runValidators: true },
    ).select("-password");

    if (!updated) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("CRM schema updateOnlineProfile error:", error);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "Duplicate email or phone" });
    }
    return res.status(500).json({ success: false, message: error.message || "Server error" });
  }
};

export default {
  ...BaseCustomerProfileOperations,
  createOnlineProfile,
  updateOnlineProfile,
};
