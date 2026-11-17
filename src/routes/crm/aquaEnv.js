import express from "express";
import controller from "../../controllers/crm/aquaEnv.js";
import { requirePermission } from "../../middleware/permissions.js";

// Mounted at /v1/crm/env. Runtime configuration stored in "aqua-env".
const router = express.Router();
router.get("/", ...requirePermission("settings.read"), controller.list);
router.get("/:key", ...requirePermission("settings.read"), controller.get);
router.put("/:key", ...requirePermission("settings.manage"), controller.set);
router.delete(
  "/:key",
  ...requirePermission("settings.manage"),
  controller.remove,
);

export default router;
