import express from "express";
import {
  createSeo,
  getSeoById,
  listSeo,
  patchSeo,
  replaceSeo,
} from "../../controllers/seo.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

router.get("/", ...requirePermission("seo.read"), listSeo);
router.get("/:id", ...requirePermission("seo.read"), getSeoById);
router.post("/", ...requirePermission("seo.manage"), createSeo);
router.put("/:id", ...requirePermission("seo.manage"), replaceSeo);
router.patch("/:id", ...requirePermission("seo.manage"), patchSeo);

export default router;
