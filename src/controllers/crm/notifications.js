import mongoose from "mongoose";
import CrmNotification from "../../models/crm/notification.js";
import { subscribeToCrmNotifications } from "../../services/crmNotifications.js";

const adminId = (req) => req.user?._id || req.user?.id;

const unreadClause = (id) => ({
  readBy: { $not: { $elemMatch: { adminId: id } } },
});

const getNotifications = async (req, res) => {
  try {
    const id = adminId(req);
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100);
    const skip = (page - 1) * limit;
    const filter = {};

    if (req.query.type) filter.type = req.query.type;
    if (req.query.entityType) filter.entityType = req.query.entityType;
    if (req.query.unread === "true") Object.assign(filter, unreadClause(id));

    const [notifications, total, unreadCount] = await Promise.all([
      CrmNotification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CrmNotification.countDocuments(filter),
      CrmNotification.countDocuments(unreadClause(id)),
    ]);

    return res.json({
      success: true,
      data: notifications,
      unreadCount,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch CRM notifications",
      error: error.message,
    });
  }
};

const getUnreadCount = async (req, res) => {
  try {
    const count = await CrmNotification.countDocuments(unreadClause(adminId(req)));
    return res.json({ success: true, unreadCount: count });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to count unread CRM notifications",
      error: error.message,
    });
  }
};

const markRead = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid notification id" });
    }

    const userId = adminId(req);
    const notification = await CrmNotification.findById(id);
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    const alreadyRead = notification.readBy.some(
      (entry) => String(entry.adminId) === String(userId),
    );
    if (!alreadyRead) {
      notification.readBy.push({ adminId: userId, readAt: new Date() });
      await notification.save();
    }

    return res.json({ success: true, data: notification });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to mark notification read",
      error: error.message,
    });
  }
};

const markAllRead = async (req, res) => {
  try {
    const userId = adminId(req);
    const result = await CrmNotification.updateMany(unreadClause(userId), {
      $push: { readBy: { adminId: userId, readAt: new Date() } },
    });

    return res.json({
      success: true,
      modifiedCount: result.modifiedCount || 0,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to mark notifications read",
      error: error.message,
    });
  }
};

const streamNotifications = async (req, res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const writeEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent("connected", {
    connected: true,
    serverTime: new Date().toISOString(),
  });

  const unsubscribe = subscribeToCrmNotifications((notification) => {
    writeEvent("notification", notification);
  });

  const heartbeat = setInterval(() => {
    writeEvent("heartbeat", { ts: Date.now() });
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  });
};

const CRMNotificationOperations = {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  streamNotifications,
};

export default CRMNotificationOperations;
