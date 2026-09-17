import express from "express";
import { getLiveAnalytics, recordVisitEvent } from "../controllers/analytics.js";
import { requirePermission } from "../middleware/permissions.js";

const router = express.Router();

router.post("/event", recordVisitEvent);
router.get("/live", ...requirePermission("analytics.read"), getLiveAnalytics);

export default router;
