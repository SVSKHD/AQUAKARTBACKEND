import mongoose from "mongoose";
import AquaActivity from "../../models/crm/activity.js";

const isValidObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id || ""));

const cleanPayload = (body = {}) => {
  const payload = { ...body };
  delete payload._id;
  delete payload.id;
  delete payload.created_at;
  delete payload.updated_at;
  delete payload.created_by;

  if (payload.due_date === "") payload.due_date = null;

  if (payload.status === "completed") {
    payload.completed_at = payload.completed_at || new Date();
  } else if (payload.status === "pending") {
    payload.completed_at = null;
  }

  return payload;
};

const getActivities = async (req, res) => {
  try {
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.related_to) filter.related_to = req.query.related_to;
    if (req.query.related_id) filter.related_id = req.query.related_id;
    if (req.query.assigned_to && isValidObjectId(req.query.assigned_to)) {
      filter.assigned_to = req.query.assigned_to;
    }

    const activities = await AquaActivity.find(filter)
      .sort({ due_date: 1, created_at: -1 })
      .populate("assigned_to", "firstName lastName email");

    return res.status(200).json({
      success: true,
      data: activities,
      count: activities.length,
    });
  } catch (error) {
    console.error("getActivities error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const getActivityById = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid activity id" });
    }

    const activity = await AquaActivity.findById(req.params.id).populate(
      "assigned_to",
      "firstName lastName email",
    );

    if (!activity) {
      return res
        .status(404)
        .json({ success: false, message: "Activity not found" });
    }

    return res.status(200).json({ success: true, data: activity });
  } catch (error) {
    console.error("getActivityById error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const createActivity = async (req, res) => {
  try {
    const payload = cleanPayload(req.body);
    payload.created_by = req.user?._id || null;

    const activity = await AquaActivity.create(payload);
    return res.status(201).json({ success: true, data: activity });
  } catch (error) {
    console.error("createActivity error:", error);
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

const updateActivity = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid activity id" });
    }

    const payload = cleanPayload(req.body);
    const activity = await AquaActivity.findByIdAndUpdate(
      req.params.id,
      payload,
      {
        new: true,
        runValidators: true,
      },
    ).populate("assigned_to", "firstName lastName email");

    if (!activity) {
      return res
        .status(404)
        .json({ success: false, message: "Activity not found" });
    }

    return res.status(200).json({ success: true, data: activity });
  } catch (error) {
    console.error("updateActivity error:", error);
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

const deleteActivity = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid activity id" });
    }

    const activity = await AquaActivity.findByIdAndDelete(req.params.id);
    if (!activity) {
      return res
        .status(404)
        .json({ success: false, message: "Activity not found" });
    }

    return res.status(200).json({
      success: true,
      data: { id: String(activity._id) },
    });
  } catch (error) {
    console.error("deleteActivity error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

export default {
  getActivities,
  getActivityById,
  createActivity,
  updateActivity,
  deleteActivity,
};
