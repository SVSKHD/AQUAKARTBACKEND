import express from "express";
import CRMNotificationOperations from "../../controllers/crm/notifications.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get(
  "/",
  userAuth.checkAdmin,
  CRMNotificationOperations.getNotifications,
);
router.get(
  "/unread-count",
  userAuth.checkAdmin,
  CRMNotificationOperations.getUnreadCount,
);
router.get(
  "/stream",
  userAuth.checkAdmin,
  CRMNotificationOperations.streamNotifications,
);
router.patch(
  "/read-all",
  userAuth.checkAdmin,
  CRMNotificationOperations.markAllRead,
);
router.patch(
  "/:id/read",
  userAuth.checkAdmin,
  CRMNotificationOperations.markRead,
);

export default router;
