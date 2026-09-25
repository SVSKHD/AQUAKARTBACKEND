import mongoose from "mongoose";
import AquaLead from "../../models/crm/lead.js";
import { calculateLeadScore } from "../../utils/crmLeadScore.js";

const isValidObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id || ""));

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^$()|[\]\\]/g, "\\$&");

const cleanPayload = (body = {}) => {
  const payload = { ...body };
  [
    "_id",
    "id",
    "created_at",
    "updated_at",
    "created_by",
    "stage_history",
    "follow_ups",
    "next_follow_up",
    "score",
    "score_band",
    "score_breakdown",
    "score_updated_at",
  ].forEach((field) => delete payload[field]);
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

const validateLostReason = (status, lostReason = {}) => {
  if (status !== "lost") return null;
  if (!String(lostReason?.category || "").trim()) {
    return "Lost reason category is required when a lead is marked lost";
  }
  return null;
};

const mergeNested = (existingValue, nextValue) => {
  if (!nextValue || typeof nextValue !== "object") return nextValue;
  const existing =
    existingValue && typeof existingValue.toObject === "function"
      ? existingValue.toObject()
      : existingValue || {};
  return { ...existing, ...nextValue };
};

const syncNextFollowUp = (lead) => {
  const scheduled = (lead.follow_ups || [])
    .filter((item) => item.status === "scheduled" && item.scheduled_for)
    .sort(
      (a, b) =>
        new Date(a.scheduled_for).getTime() -
        new Date(b.scheduled_for).getTime(),
    );

  lead.next_follow_up = scheduled[0]?.scheduled_for || null;
};

const applyLeadScore = (lead) => {
  const result = calculateLeadScore(
    typeof lead.toObject === "function" ? lead.toObject() : lead,
  );
  lead.score = result.score;
  lead.score_band = result.band;
  lead.score_breakdown = result.breakdown;
  lead.score_updated_at = new Date();
  return result;
};

const enrichLostReason = (lead, userId) => {
  if (lead.status !== "lost") return;
  lead.lost_reason.lost_at = lead.lost_reason.lost_at || new Date();
  lead.lost_reason.lost_by = lead.lost_reason.lost_by || userId || null;
};

const getLeads = async (req, res) => {
  try {
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.source) filter.source = req.query.source;
    if (req.query.payment_status) {
      filter.payment_status = req.query.payment_status;
    }
    if (req.query.score_band) filter.score_band = req.query.score_band;

    const minScore = Number(req.query.min_score);
    if (req.query.min_score !== undefined && Number.isFinite(minScore)) {
      filter.score = { ...(filter.score || {}), $gte: minScore };
    }
    const maxScore = Number(req.query.max_score);
    if (req.query.max_score !== undefined && Number.isFinite(maxScore)) {
      filter.score = { ...(filter.score || {}), $lte: maxScore };
    }

    if (req.query.assigned_to && isValidObjectId(req.query.assigned_to)) {
      filter.assigned_to = req.query.assigned_to;
    }

    if (req.query.product_interest) {
      filter["qualification.product_interest"] = req.query.product_interest;
    }
    if (req.query.water_source) {
      filter["qualification.water_source"] = req.query.water_source;
    }
    if (req.query.pincode) {
      filter["qualification.pincode"] = String(req.query.pincode).trim();
    }
    if (req.query.locality) {
      filter["qualification.locality"] = new RegExp(
        escapeRegex(req.query.locality),
        "i",
      );
    }

    const now = new Date();
    if (req.query.follow_up === "overdue") {
      filter.next_follow_up = { $lt: now };
      filter.status = { $nin: ["won", "lost"] };
    } else if (req.query.follow_up === "upcoming") {
      filter.next_follow_up = { $gte: now };
      filter.status = { $nin: ["won", "lost"] };
    } else if (req.query.follow_up === "today") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      filter.next_follow_up = { $gte: start, $lte: end };
      filter.status = { $nin: ["won", "lost"] };
    } else if (req.query.follow_up === "none") {
      filter.next_follow_up = null;
    }

    if (req.query.reminder_due === "true") {
      filter.follow_ups = {
        $elemMatch: {
          status: "scheduled",
          reminder_status: "pending",
          reminder_at: { $ne: null, $lte: now },
        },
      };
    }

    if (req.query.search) {
      const search = new RegExp(escapeRegex(req.query.search), "i");
      filter.$or = [
        { company_name: search },
        { contact_name: search },
        { email: search },
        { phone: search },
        { source: search },
        { "qualification.locality": search },
        { "qualification.pincode": search },
        { "qualification.water_problem": search },
      ];
    }

    let sort = { created_at: -1 };
    if (req.query.sort === "score") sort = { score: -1, created_at: -1 };
    if (req.query.sort === "follow_up") {
      sort = { next_follow_up: 1, score: -1 };
    }

    const leads = await AquaLead.find(filter)
      .sort(sort)
      .populate("assigned_to", "firstName lastName email")
      .populate("stage_history.changed_by", "firstName lastName email")
      .populate("follow_ups.created_by", "firstName lastName email")
      .populate("follow_ups.completed_by", "firstName lastName email")
      .populate("lost_reason.lost_by", "firstName lastName email");

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

const getPipelineSummary = async (_req, res) => {
  try {
    const [byStatus, byScoreBand, byLostReason, followUps] = await Promise.all([
      AquaLead.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AquaLead.aggregate([
        { $group: { _id: "$score_band", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AquaLead.aggregate([
        { $match: { status: "lost" } },
        { $group: { _id: "$lost_reason.category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AquaLead.aggregate([
        {
          $facet: {
            overdue: [
              {
                $match: {
                  next_follow_up: { $lt: new Date() },
                  status: { $nin: ["won", "lost"] },
                },
              },
              { $count: "count" },
            ],
            upcoming: [
              {
                $match: {
                  next_follow_up: { $gte: new Date() },
                  status: { $nin: ["won", "lost"] },
                },
              },
              { $count: "count" },
            ],
          },
        },
      ]),
    ]);

    const mapCounts = (items) =>
      Object.fromEntries(items.map((item) => [item._id || "unknown", item.count]));

    return res.status(200).json({
      success: true,
      data: {
        by_status: mapCounts(byStatus),
        by_score_band: mapCounts(byScoreBand),
        lost_reasons: mapCounts(byLostReason),
        follow_ups: {
          overdue: followUps[0]?.overdue?.[0]?.count || 0,
          upcoming: followUps[0]?.upcoming?.[0]?.count || 0,
        },
      },
    });
  } catch (error) {
    console.error("getPipelineSummary error:", error);
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
      .populate("assigned_to", "firstName lastName email")
      .populate("stage_history.changed_by", "firstName lastName email")
      .populate("follow_ups.created_by", "firstName lastName email")
      .populate("follow_ups.completed_by", "firstName lastName email")
      .populate("lost_reason.lost_by", "firstName lastName email");

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

    const lostReasonError = validateLostReason(
      payload.status || "new",
      payload.lost_reason,
    );
    if (lostReasonError) {
      return res
        .status(400)
        .json({ success: false, message: lostReasonError });
    }

    payload.created_by = req.user?._id || null;

    const lead = new AquaLead(payload);
    lead.stage_history.push({
      from: "",
      to: lead.status,
      changed_by: req.user?._id || null,
      note: String(req.body.stage_note || "").trim(),
    });
    enrichLostReason(lead, req.user?._id);
    syncNextFollowUp(lead);
    applyLeadScore(lead);

    await lead.save();
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

    const lead = await AquaLead.findById(req.params.id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    const payload = cleanPayload(req.body);
    const validationError = validateContact(payload, lead);

    if (validationError) {
      return res
        .status(400)
        .json({ success: false, message: validationError });
    }

    const nextStatus = payload.status || lead.status;
    const mergedLostReason = mergeNested(lead.lost_reason, payload.lost_reason);
    const lostReasonError = validateLostReason(nextStatus, mergedLostReason);
    if (lostReasonError) {
      return res
        .status(400)
        .json({ success: false, message: lostReasonError });
    }

    const previousStatus = lead.status;

    if (payload.qualification) {
      payload.qualification = mergeNested(
        lead.qualification,
        payload.qualification,
      );
    }
    if (payload.lost_reason) {
      payload.lost_reason = mergedLostReason;
    }

    lead.set(payload);

    if (previousStatus !== lead.status) {
      lead.stage_history.push({
        from: previousStatus,
        to: lead.status,
        changed_by: req.user?._id || null,
        note: String(req.body.stage_note || "").trim(),
      });
    }

    if (lead.status === "lost") {
      enrichLostReason(lead, req.user?._id);
    } else if (previousStatus === "lost") {
      lead.lost_reason = {
        category: "",
        details: "",
        competitor: "",
        lost_at: null,
        lost_by: null,
      };
    }

    syncNextFollowUp(lead);
    applyLeadScore(lead);

    await lead.save();

    await lead.populate("assigned_to", "firstName lastName email");
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

const scheduleFollowUp = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lead id" });
    }

    const scheduledFor = new Date(req.body.scheduled_for);
    if (!req.body.scheduled_for || Number.isNaN(scheduledFor.getTime())) {
      return res.status(400).json({
        success: false,
        message: "A valid scheduled_for date is required",
      });
    }

    const lead = await AquaLead.findById(req.params.id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    let reminderAt = null;
    if (req.body.reminder_at) {
      reminderAt = new Date(req.body.reminder_at);
      if (Number.isNaN(reminderAt.getTime())) {
        return res.status(400).json({
          success: false,
          message: "reminder_at must be a valid date",
        });
      }
    }

    lead.follow_ups.push({
      scheduled_for: scheduledFor,
      status: "scheduled",
      note: String(req.body.note || "").trim(),
      reminder_at: reminderAt,
      reminder_status: reminderAt ? "pending" : "skipped",
      created_by: req.user?._id || null,
    });

    syncNextFollowUp(lead);
    applyLeadScore(lead);
    await lead.save();

    return res.status(201).json({
      success: true,
      data: lead,
      follow_up: lead.follow_ups[lead.follow_ups.length - 1],
    });
  } catch (error) {
    console.error("scheduleFollowUp error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const updateFollowUp = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lead id" });
    }

    const lead = await AquaLead.findById(req.params.id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    const followUp = lead.follow_ups.id(req.params.followUpId);
    if (!followUp) {
      return res
        .status(404)
        .json({ success: false, message: "Follow-up not found" });
    }

    if (req.body.scheduled_for !== undefined) {
      const scheduledFor = new Date(req.body.scheduled_for);
      if (Number.isNaN(scheduledFor.getTime())) {
        return res.status(400).json({
          success: false,
          message: "scheduled_for must be a valid date",
        });
      }
      followUp.scheduled_for = scheduledFor;
    }

    if (req.body.note !== undefined) {
      followUp.note = String(req.body.note || "").trim();
    }

    if (req.body.reminder_at !== undefined) {
      if (!req.body.reminder_at) {
        followUp.reminder_at = null;
        followUp.reminder_status = "skipped";
      } else {
        const reminderAt = new Date(req.body.reminder_at);
        if (Number.isNaN(reminderAt.getTime())) {
          return res.status(400).json({
            success: false,
            message: "reminder_at must be a valid date",
          });
        }
        followUp.reminder_at = reminderAt;
        followUp.reminder_status = "pending";
        followUp.reminder_sent_at = null;
      }
    }

    if (req.body.reminder_status !== undefined) {
      followUp.reminder_status = req.body.reminder_status;
      if (req.body.reminder_status === "sent") {
        followUp.reminder_sent_at = new Date();
      }
    }

    if (req.body.status !== undefined) {
      followUp.status = req.body.status;
      if (req.body.status === "completed") {
        followUp.completed_at = new Date();
        followUp.completed_by = req.user?._id || null;
        if (followUp.reminder_status === "pending") {
          followUp.reminder_status = "skipped";
        }
      } else if (req.body.status === "scheduled") {
        followUp.completed_at = null;
        followUp.completed_by = null;
      }
    }

    syncNextFollowUp(lead);
    applyLeadScore(lead);
    await lead.save();

    return res.status(200).json({
      success: true,
      data: lead,
      follow_up: followUp,
    });
  } catch (error) {
    console.error("updateFollowUp error:", error);
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

const recalculateLeadScore = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lead id" });
    }

    const lead = await AquaLead.findById(req.params.id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    syncNextFollowUp(lead);
    const score = applyLeadScore(lead);
    await lead.save();

    return res.status(200).json({
      success: true,
      data: lead,
      score,
    });
  } catch (error) {
    console.error("recalculateLeadScore error:", error);
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
  getPipelineSummary,
  getLeadById,
  createLead,
  updateLead,
  scheduleFollowUp,
  updateFollowUp,
  recalculateLeadScore,
  deleteLead,
};
