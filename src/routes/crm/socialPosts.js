import express from "express";
import { requirePermission } from "../../middleware/permissions.js";
import { createSocialPostController } from "../../controllers/crm/socialPosts.js";
import { mcpServices } from "../mcp.js";

// AQUACRM social post review. Mounted at /v1/crm/social-posts.
// Approve/reject need social.review; publishing an approved post also needs
// instagram.publish. MCP clients can never reach approve.

export const createSocialPostRouter = (socialTools) => {
  const router = express.Router();
  const controller = createSocialPostController({ socialTools });

  router.get("/", ...requirePermission("social.read"), controller.list);
  router.get("/:id", ...requirePermission("social.read"), controller.get);
  router.patch(
    "/:id",
    ...requirePermission("social.manage"),
    controller.update,
  );
  router.post(
    "/:id/approve",
    ...requirePermission("social.review"),
    controller.approve,
  );
  router.post(
    "/:id/reject",
    ...requirePermission("social.review"),
    controller.reject,
  );
  router.post(
    "/:id/publish",
    ...requirePermission("social.review", "instagram.publish"),
    controller.publish,
  );
  return router;
};

export default createSocialPostRouter(mcpServices.socialTools);
