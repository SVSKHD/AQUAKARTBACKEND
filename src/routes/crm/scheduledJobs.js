import express from "express";
import Jobs from "../../controllers/crm/scheduledJobs.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
const read = requirePermission("jobs.read");
const manage = requirePermission("jobs.manage");
const jobId = Jobs.validateObjectId("id");

router.get("/actions", ...read, Jobs.listActions);
router.post("/preview-schedule", ...read, Jobs.previewSchedule);
router.get(
  "/runs/:runId",
  ...read,
  Jobs.validateObjectId("runId"),
  Jobs.getRun,
);

router.get("/", ...read, Jobs.listJobs);
router.post("/", ...manage, Jobs.createJob);
router.get("/:id", ...read, jobId, Jobs.getJob);
router.patch("/:id", ...manage, jobId, Jobs.updateJob);
router.delete("/:id", ...manage, jobId, Jobs.deleteJob);
router.post("/:id/run", ...manage, jobId, Jobs.runJob);
router.get("/:id/runs", ...read, jobId, Jobs.listJobRuns);

export default router;
