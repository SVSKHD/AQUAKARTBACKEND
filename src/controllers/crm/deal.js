import mongoose from "mongoose";
import AquaDeal from "../../models/crm/deal.js";

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

  if (payload.expected_close_date === "") {
    payload.expected_close_date = null;
  }

  return payload;
};

const mergeNested = (existingValue, nextValue) => {
  if (!nextValue || typeof nextValue !== "object") return nextValue;
  const existing =
    existingValue && typeof existingValue.toObject === "function"
      ? existingValue.toObject()
      : existingValue || {};
  return { ...existing, ...nextValue };
};

const validateLostReason = (stage, lostReason = {}) => {
  if (stage !== "closed_lost") return null;
  if (!String(lostReason?.category || "").trim()) {
    return "Lost reason category is required when a deal is closed lost";
  }
  return null;
};

const enrichLostReason = (deal, userId) => {
  if (deal.stage !== "closed_lost") return;
  deal.lost_reason.lost_at = deal.lost_reason.lost_at || new Date();
  deal.lost_reason.lost_by = deal.lost_reason.lost_by || userId || null;
};

const getDeals = async (req, res) => {
  try {
    const filter = {};

    if (req.query.stage) filter.stage = req.query.stage;
    if (req.query.lead_id && isValidObjectId(req.query.lead_id)) {
      filter.lead_id = req.query.lead_id;
    }
    if (req.query.customer_id) {
      filter.customer_id = String(req.query.customer_id).trim();
    }
    if (req.query.assigned_to && isValidObjectId(req.query.assigned_to)) {
      filter.assigned_to = req.query.assigned_to;
    }
    if (req.query.search) {
      const search = new RegExp(escapeRegex(req.query.search), "i");
      filter.$or = [{ title: search }, { notes: search }];
    }

    const deals = await AquaDeal.find(filter)
      .sort({ created_at: -1 })
      .populate("lead_id", "company_name contact_name email phone status source")
      .populate("quotation_id", "quotationNo status totalAmount")
      .populate("assigned_to", "firstName lastName email")
      .populate("lost_reason.lost_by", "firstName lastName email");

    return res.status(200).json({
      success: true,
      data: deals,
      count: deals.length,
    });
  } catch (error) {
    console.error("getDeals error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const getDealById = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid deal id" });
    }

    const deal = await AquaDeal.findById(req.params.id)
      .populate("lead_id", "company_name contact_name email phone status source")
      .populate("quotation_id", "quotationNo status totalAmount")
      .populate("assigned_to", "firstName lastName email")
      .populate("lost_reason.lost_by", "firstName lastName email");

    if (!deal) {
      return res
        .status(404)
        .json({ success: false, message: "Deal not found" });
    }

    return res.status(200).json({ success: true, data: deal });
  } catch (error) {
    console.error("getDealById error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const createDeal = async (req, res) => {
  try {
    const payload = cleanPayload(req.body);
    const lostReasonError = validateLostReason(
      payload.stage || "prospecting",
      payload.lost_reason,
    );

    if (lostReasonError) {
      return res
        .status(400)
        .json({ success: false, message: lostReasonError });
    }

    payload.created_by = req.user?._id || null;

    const deal = new AquaDeal(payload);
    enrichLostReason(deal, req.user?._id);
    await deal.save();

    return res.status(201).json({ success: true, data: deal });
  } catch (error) {
    console.error("createDeal error:", error);
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

const updateDeal = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid deal id" });
    }

    const deal = await AquaDeal.findById(req.params.id);
    if (!deal) {
      return res
        .status(404)
        .json({ success: false, message: "Deal not found" });
    }

    const payload = cleanPayload(req.body);
    const previousStage = deal.stage;
    const nextStage = payload.stage || deal.stage;
    const mergedLostReason = mergeNested(deal.lost_reason, payload.lost_reason);
    const lostReasonError = validateLostReason(nextStage, mergedLostReason);

    if (lostReasonError) {
      return res
        .status(400)
        .json({ success: false, message: lostReasonError });
    }

    if (payload.lost_reason) {
      payload.lost_reason = mergedLostReason;
    }

    deal.set(payload);

    if (deal.stage === "closed_lost") {
      enrichLostReason(deal, req.user?._id);
    } else if (previousStage === "closed_lost") {
      deal.lost_reason = {
        category: "",
        details: "",
        competitor: "",
        lost_at: null,
        lost_by: null,
      };
    }

    await deal.save();

    await deal.populate("lead_id", "company_name contact_name email phone status source");
    await deal.populate("quotation_id", "quotationNo status totalAmount");
    await deal.populate("assigned_to", "firstName lastName email");

    return res.status(200).json({ success: true, data: deal });
  } catch (error) {
    console.error("updateDeal error:", error);
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

const deleteDeal = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid deal id" });
    }

    const deal = await AquaDeal.findByIdAndDelete(req.params.id);
    if (!deal) {
      return res
        .status(404)
        .json({ success: false, message: "Deal not found" });
    }

    return res.status(200).json({
      success: true,
      data: { id: String(deal._id) },
    });
  } catch (error) {
    console.error("deleteDeal error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

export default {
  getDeals,
  getDealById,
  createDeal,
  updateDeal,
  deleteDeal,
};
