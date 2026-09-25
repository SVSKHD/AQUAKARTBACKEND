import mongoose from "mongoose";
import AquaLead from "../../models/crm/lead.js";

const isValidObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id || ""));

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^$()|[\]\\]/g, "\\$&");

const cleanPayload = (body = {}) => {
  const payload = { ...body };
  delete payload._id;
  delete payload.id;
  delete payload.created_at;
  delete payload.updated_at;
  delete payload.created_by;
  return payload;
};

const validateContact = (payload = {}, existing = null) => {
  const contactName =
    payload.contact_name !== undefined
      ? String(payload.contact_name || "").trim()
      : String(existing?.contact_name || "").trim();
  const phone =
    payload.phone !== undefined
      ? String(payload.phone || "").trim()
      : String(existing?.phone || "").trim();
  const email =
    payload.email !== undefined
      ? String(payload.email || "").trim()
      : String(existing?.email || "").trim();

  if (!contactName) return "Contact name is required";
  if (!phone && !email) return "Phone or email is required";
  return null;
};

const getLeads = async (req, res) => {
  try {
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.source) filter.source = req.query.source;
    if (req.query.payment_status) {
      filter.payment_status = req.query.payment_status;
    }
    if (req.query.assigned_to && isValidObjectId(req.query.assigned_to)) {
      filter.assigned_to = req.query.assigned_to;
    }

    if (req.query.search) {
      const search = new RegExp(escapeRegex(req.query.search), "i");
      filter.$or = [
        { company_name: search },
        { contact_name: search },
        { email: search },
        { phone: search },
        { source: search },
      ];
    }

    const leads = await AquaLead.find(filter)
      .sort({ created_at: -1 })
      .populate("assigned_to", "firstName lastName email");

    return res.status(200).json({
      success: true,
      data: leads,
      count: leads.length,
    });
  } catch (error) {
    console.error("getLeads error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const getLeadById = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lead id" });
    }

    const lead = await AquaLead.findById(req.params.id)
      .populate("assigned_to", "firstName lastName email");

    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    return res.status(200).json({ success: true, data: lead });
  } catch (error) {
    console.error("getLeadById error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const createLead = async (req, res) => {
  try {
    const payload = cleanPayload(req.body);
    const validationError = validateContact(payload);

    if (validationError) {
      return res
        .status(400)
        .json({ success: false, message: validationError });
    }

    payload.created_by = req.user?._id || null;

    const lead = await AquaLead.create(payload);
    return res.status(201).json({ success: true, data: lead });
  } catch (error) {
    console.error("createLead error:", error);
    if (error?.name === "ValidationError" || error?.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const updateLead = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lead id" });
    }

    const existing = await AquaLead.findById(req.params.id);
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    const payload = cleanPayload(req.body);
    const validationError = validateContact(payload, existing);

    if (validationError) {
      return res
        .status(400)
        .json({ success: false, message: validationError });
    }

    const lead = await AquaLead.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    })
      .populate("assigned_to", "firstName lastName email");

    return res.status(200).json({ success: true, data: lead });
  } catch (error) {
    console.error("updateLead error:", error);
    if (error?.name === "ValidationError" || error?.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const deleteLead = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lead id" });
    }

    const lead = await AquaLead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    return res.status(200).json({
      success: true,
      data: { id: String(lead._id) },
    });
  } catch (error) {
    console.error("deleteLead error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

export default {
  getLeads,
  getLeadById,
  createLead,
  updateLead,
  deleteLead,
};
