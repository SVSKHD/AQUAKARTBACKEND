import express from "express";
import * as controller from "../../controllers/crm/accessControl.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
router.get(
  "/permissions",
  ...requirePermission("roles.read"),
  controller.listPermissions,
);
router.get("/roles", ...requirePermission("roles.read"), controller.listRoles);
router.post(
  "/roles",
  ...requirePermission("roles.manage"),
  controller.createRole,
);
router.patch(
  "/roles/:id",
  ...requirePermission("roles.manage"),
  controller.updateRole,
);
router.delete(
  "/roles/:id",
  ...requirePermission("roles.manage"),
  controller.archiveRole,
);
router.get("/staff", ...requirePermission("staff.read"), controller.listStaff);
router.post(
  "/staff",
  ...requirePermission("staff.manage"),
  controller.createStaff,
);
router.patch(
  "/staff/:id",
  ...requirePermission("staff.manage"),
  controller.updateStaff,
);
router.patch(
  "/staff/:id/status",
  ...requirePermission("staff.manage"),
  controller.updateStaffStatus,
);
router.get(
  "/audit-logs",
  ...requirePermission("audit.read"),
  controller.listAuditLogs,
);

export default router;
