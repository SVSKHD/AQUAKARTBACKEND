import mongoose from "mongoose";
import ScheduledJob from "../../models/crm/scheduledJob.js";
import ScheduledJobRun from "../../models/crm/scheduledJobRun.js";
import { writeAudit } from "../../services/audit.js";
import { describeActions } from "../../services/scheduler/actions.js";
import {
  SCHEDULE_FIELDS,
  computeNextRunAt,
  normalizeJobInput,
} from "../../services/scheduler/schedule.js";
import { JobBusyError, runJobNow } from "../../services/scheduler/index.js";
import { isValidTimeZone, nextCronRuns } from "../../utils/cron.js";

const HIDDEN_FIELDS = "-lockedBy -__v";

const badRequest = (res, message) =>
  res.status(400).json({ success: false, message });
const notFound = (res, message = "Job not found") =>
  res.status(404).json({ success: false, message });
const serverError = (res, label, error) => {
  console.error(`${label} error:`, error);
  return res.status(500).json({ success: false, message: "Server error" });
};

const pagination = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(query.limit, 10) || 20),
  );
  return { page, limit, skip: (page - 1) * limit };
};

const listActions = (_req, res) => {
  res.json({ success: true, data: describeActions() });
};

// Lets the frontend show "next 5 runs" while the user edits a cron expression.
const previewSchedule = (req, res) => {
  const { cron, timezone = "Asia/Kolkata", count = 5 } = req.body || {};
  if (!isValidTimeZone(timezone)) {
    return badRequest(res, `Unknown timezone "${timezone}"`);
  }
  try {
    const runs = nextCronRuns(
      cron,
      Math.min(20, Math.max(1, Number(count) || 5)),
      new Date(),
      timezone,
    );
    return res.json({
      success: true,
      data: { valid: true, nextRuns: runs.map((date) => date.toISOString()) },
    });
  } catch (error) {
    return res.json({
      success: true,
      data: { valid: false, message: error.message, nextRuns: [] },
    });
  }
};

const listJobs = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const filter = {};
    if (req.query.enabled === "true") filter.enabled = true;
    if (req.query.enabled === "false") filter.enabled = false;
    if (req.query.system === "true") filter.system = true;
    if (req.query.system === "false") filter.system = false;
    if (req.query.action) filter.action = String(req.query.action);
    if (req.query.status) filter.lastStatus = String(req.query.status);
    if (req.query.q) {
      const escaped = String(req.query.q).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      filter.name = { $regex: escaped, $options: "i" };
    }

    const [items, total] = await Promise.all([
      ScheduledJob.find(filter)
        .select(HIDDEN_FIELDS)
        .sort({ system: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ScheduledJob.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return serverError(res, "listJobs", error);
  }
};

const getJob = async (req, res) => {
  try {
    const job = await ScheduledJob.findById(req.params.id)
      .select(HIDDEN_FIELDS)
      .lean();
    if (!job) return notFound(res);
    return res.json({ success: true, data: job });
  } catch (error) {
    return serverError(res, "getJob", error);
  }
};

const createJob = async (req, res) => {
  try {
    const now = new Date();
    const { data, error } = normalizeJobInput(req.body, null, now);
    if (error) return badRequest(res, error);

    const job = await ScheduledJob.create({
      ...data,
      nextRunAt: data.enabled ? computeNextRunAt(data, now) : null,
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });
    await writeAudit({
      req,
      action: "scheduled_job.create",
      resourceType: "ScheduledJob",
      resourceId: job._id,
      after: job.toObject(),
    });
    return res.status(201).json({ success: true, data: job });
  } catch (error) {
    return serverError(res, "createJob", error);
  }
};

const updateJob = async (req, res) => {
  try {
    const job = await ScheduledJob.findById(req.params.id);
    if (!job) return notFound(res);

    const now = new Date();
    const before = job.toObject();
    const { data, error } = normalizeJobInput(req.body, before, now);
    if (error) return badRequest(res, error);

    const scheduleChanged = SCHEDULE_FIELDS.some(
      (field) => req.body?.[field] !== undefined,
    );
    job.set({ ...data, updatedBy: req.user?._id });
    if (!job.enabled) {
      job.nextRunAt = null;
    } else if (scheduleChanged || !job.nextRunAt) {
      job.nextRunAt = computeNextRunAt(job, now);
    }
    await job.save();

    await writeAudit({
      req,
      action: "scheduled_job.update",
      resourceType: "ScheduledJob",
      resourceId: job._id,
      before,
      after: job.toObject(),
    });
    return res.json({ success: true, data: job });
  } catch (error) {
    return serverError(res, "updateJob", error);
  }
};

const deleteJob = async (req, res) => {
  try {
    const job = await ScheduledJob.findById(req.params.id);
    if (!job) return notFound(res);
    if (job.system) {
      return badRequest(
        res,
        "Built-in jobs cannot be deleted. Disable them instead.",
      );
    }
    await job.deleteOne();
    await writeAudit({
      req,
      action: "scheduled_job.delete",
      resourceType: "ScheduledJob",
      resourceId: job._id,
      before: job.toObject(),
    });
    return res.json({ success: true, message: "Job deleted" });
  } catch (error) {
    return serverError(res, "deleteJob", error);
  }
};

const runJob = async (req, res) => {
  try {
    const run = await runJobNow(req.params.id, req.user?._id);
    if (!run) return notFound(res);
    await writeAudit({
      req,
      action: "scheduled_job.run",
      resourceType: "ScheduledJob",
      resourceId: req.params.id,
      metadata: { runId: String(run._id) },
    });
    // The job keeps running in the background; poll GET /runs/:runId.
    return res.status(202).json({ success: true, data: run });
  } catch (error) {
    if (error instanceof JobBusyError) {
      return res.status(409).json({ success: false, message: error.message });
    }
    return serverError(res, "runJob", error);
  }
};

const listJobRuns = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const filter = { job: req.params.id };
    if (req.query.status) filter.status = String(req.query.status);
    const [items, total] = await Promise.all([
      ScheduledJobRun.find(filter)
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("triggeredBy", "name email")
        .lean(),
      ScheduledJobRun.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return serverError(res, "listJobRuns", error);
  }
};

const getRun = async (req, res) => {
  try {
    const run = await ScheduledJobRun.findById(req.params.runId)
      .populate("triggeredBy", "name email")
      .lean();
    if (!run) return notFound(res, "Run not found");
    return res.json({ success: true, data: run });
  } catch (error) {
    return serverError(res, "getRun", error);
  }
};

const validateObjectId = (param) => (req, res, next) =>
  mongoose.isValidObjectId(req.params[param])
    ? next()
    : badRequest(res, `Invalid ${param}`);

const ScheduledJobOperations = {
  listActions,
  previewSchedule,
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  runJob,
  listJobRuns,
  getRun,
  validateObjectId,
};

export default ScheduledJobOperations;
