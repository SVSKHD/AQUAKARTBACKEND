import os from "os";
import ScheduledJob from "../../models/crm/scheduledJob.js";
import ScheduledJobRun from "../../models/crm/scheduledJobRun.js";
import { ACTIONS } from "./actions.js";
import { DEFAULT_TIMEZONE, computeNextRunAt } from "./schedule.js";

// DB-driven scheduler: jobs live in MongoDB and every instance polls for due
// jobs, claiming each one with an atomic lock, so CRM edits apply on the next
// tick without a restart and multiple instances never double-run a job.

export const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
const TICK_MS = 30 * 1000;
const LOCK_GRACE_MS = 60 * 1000;
const MAX_RESULT_CHARS = 16000;
const MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.SCHEDULER_MAX_CONCURRENT) || 5,
);

let inFlight = 0;
let systemJobsSeeded = false;

const envNumber = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== ""
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
};
const envFlag = (name) =>
  String(process.env[name] || "true").toLowerCase() === "true";

// Built-in jobs that used to be hardcoded timers. The env vars only seed the
// initial schedule; after that the CRM owns the schedule and enabled flag.
const systemJobDefinitions = () => [
  {
    key: "invoice-unenriched-reminder",
    name: "Unenriched invoice reminder",
    action: "invoice.unenriched_reminder",
    cron: `0 ${envNumber("INVOICE_REMINDER_HOUR_IST", 8, 0, 23)} * * ${envNumber(
      "INVOICE_REMINDER_DAY_OF_WEEK_IST",
      1,
      0,
      6,
    )}`,
    enabled: envFlag("INVOICE_REMINDER_ENABLED"),
  },
  {
    key: "product-service-reminders",
    name: "Product service reminders",
    action: "service.product_reminders",
    cron: `0 ${envNumber("PRODUCT_SERVICE_REMINDERS_HOUR_IST", 9, 0, 23)} * * *`,
    enabled: envFlag("PRODUCT_SERVICE_REMINDERS_ENABLED"),
  },
  {
    key: "quotation-followups",
    name: "Quotation WhatsApp follow-ups",
    action: "quotation.followups",
    cron: `${envNumber("QUOTATION_FOLLOWUP_RUN_MINUTE", 10, 0, 59)} * * * *`,
    enabled: envFlag("QUOTATION_FOLLOWUPS_ENABLED"),
  },
  {
    key: "blog-ai-drafts",
    name: "AI blog drafts",
    action: "blog.ai_drafts",
    cron: `0 ${envNumber("BLOG_AI_DRAFTS_HOUR_IST", 8, 0, 23)} * * *`,
    enabled: envFlag("BLOG_AI_DRAFTS_ENABLED"),
    // Each Gemini article call can take up to a minute.
    timeoutSeconds: 900,
  },
  {
    key: "seo-ai-refresh",
    name: "AI SEO refresh",
    action: "seo.ai_refresh",
    // Weekly, Sunday 09:00 IST by default.
    cron: `0 ${envNumber("SEO_AI_REFRESH_HOUR_IST", 9, 0, 23)} * * ${envNumber(
      "SEO_AI_REFRESH_DAY_OF_WEEK_IST",
      0,
      0,
      6,
    )}`,
    enabled: envFlag("SEO_AI_REFRESH_ENABLED"),
    timeoutSeconds: 900,
  },
];

export const seedSystemJobs = async (now = new Date()) => {
  for (const definition of systemJobDefinitions()) {
    const job = {
      ...definition,
      system: true,
      description: ACTIONS[definition.action].description,
      scheduleType: "cron",
      timezone: DEFAULT_TIMEZONE,
      params: {},
    };
    try {
      await ScheduledJob.updateOne(
        { key: definition.key },
        {
          $setOnInsert: {
            ...job,
            nextRunAt: job.enabled ? computeNextRunAt(job, now) : null,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // Another instance inserted it first.
      if (error?.code !== 11000) throw error;
    }
  }
  systemJobsSeeded = true;
};

const summarizeResult = (result) => {
  if (result === undefined || result === null) return null;
  const value = Array.isArray(result)
    ? { count: result.length, items: result.slice(0, 20) }
    : result;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return json.length <= MAX_RESULT_CHARS
      ? JSON.parse(json)
      : { truncated: true, preview: json.slice(0, MAX_RESULT_CHARS) };
  } catch (_error) {
    return { note: "Result could not be serialized" };
  }
};

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms / 1000}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

const lockExpiry = (job, now) =>
  new Date(now.getTime() + job.timeoutSeconds * 1000 + LOCK_GRACE_MS);

const finishRun = async (job, run, trigger) => {
  const action = ACTIONS[job.action];
  let status = "success";
  let result;
  let error = null;

  try {
    if (!action) throw new Error(`Unknown action "${job.action}"`);
    result = await withTimeout(
      Promise.resolve().then(() =>
        action.run({ params: job.params || {}, now: run.startedAt, job }),
      ),
      job.timeoutSeconds * 1000,
    );
  } catch (caught) {
    status = "failed";
    error = String(caught?.message || caught).slice(0, 2000);
    result = caught?.result;
    console.error(`Scheduled job "${job.name}" failed:`, error);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - run.startedAt;
  await ScheduledJobRun.updateOne(
    { _id: run._id },
    {
      $set: {
        status,
        result: summarizeResult(result),
        error,
        finishedAt,
        durationMs,
      },
    },
  );

  // Re-read so schedule edits made while the job was running are respected.
  const fresh = await ScheduledJob.findById(job._id);
  if (!fresh) return;

  const update = {
    lastRunAt: run.startedAt,
    lastStatus: status,
    lastError: error,
    lastDurationMs: durationMs,
    lockUntil: null,
    lockedBy: null,
  };
  if (trigger === "schedule") {
    if (fresh.scheduleType === "once") {
      update.enabled = false;
      update.nextRunAt = null;
    } else {
      // Computed from now, so missed runs are skipped rather than replayed.
      update.nextRunAt = fresh.enabled
        ? computeNextRunAt(fresh, finishedAt)
        : null;
    }
  }

  await ScheduledJob.updateOne(
    { _id: job._id, lockedBy: INSTANCE_ID },
    {
      $set: update,
      $inc: { runCount: 1, failureCount: status === "failed" ? 1 : 0 },
    },
  );
};

// Starts a run for an already-claimed job. Resolves once the run record
// exists; `done` settles when the action finishes.
const startRun = async (job, { trigger, triggeredBy }) => {
  const run = await ScheduledJobRun.create({
    job: job._id,
    jobName: job.name,
    action: job.action,
    trigger,
    triggeredBy,
    instance: INSTANCE_ID,
    startedAt: new Date(),
  });

  inFlight += 1;
  const done = finishRun(job, run, trigger)
    .catch((error) => {
      console.error(`Scheduled job "${job.name}" bookkeeping failed:`, error);
    })
    .finally(() => {
      inFlight -= 1;
    });
  return { run, done };
};

const claimFilter = (now) => ({
  $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }],
});

const claimDueJob = async (now) => {
  const candidate = await ScheduledJob.findOne({
    enabled: true,
    nextRunAt: { $ne: null, $lte: now },
    ...claimFilter(now),
  })
    .sort({ nextRunAt: 1 })
    .select("timeoutSeconds")
    .lean();
  if (!candidate) return null;

  return ScheduledJob.findOneAndUpdate(
    {
      _id: candidate._id,
      enabled: true,
      nextRunAt: { $ne: null, $lte: now },
      ...claimFilter(now),
    },
    {
      $set: {
        lockUntil: lockExpiry(candidate, now),
        lockedBy: INSTANCE_ID,
        lastStatus: "running",
      },
    },
    { returnDocument: "after" },
  );
};

// Runs left "running" by a crashed or restarted process.
const sweepInterruptedRuns = async (now) => {
  await ScheduledJob.updateMany(
    { lastStatus: "running", lockUntil: { $lt: now } },
    {
      $set: {
        lastStatus: "failed",
        lastError: "Interrupted (server restarted or crashed)",
        lockUntil: null,
        lockedBy: null,
      },
    },
  );
  await ScheduledJobRun.updateMany(
    {
      status: "running",
      startedAt: { $lt: new Date(now.getTime() - 3600 * 1000 - LOCK_GRACE_MS) },
    },
    {
      $set: {
        status: "failed",
        error: "Interrupted (server restarted or crashed)",
        finishedAt: now,
      },
    },
  );
};

export const tick = async (now = new Date()) => {
  if (!systemJobsSeeded) await seedSystemJobs(now);
  await sweepInterruptedRuns(now);
  while (inFlight < MAX_CONCURRENT) {
    const job = await claimDueJob(now);
    if (!job) break;
    await startRun(job, { trigger: "schedule" });
  }
};

export class JobBusyError extends Error {}

export const runJobNow = async (jobId, triggeredBy) => {
  const now = new Date();
  const existing = await ScheduledJob.findById(jobId)
    .select("timeoutSeconds")
    .lean();
  if (!existing) return null;

  const job = await ScheduledJob.findOneAndUpdate(
    { _id: jobId, ...claimFilter(now) },
    {
      $set: {
        lockUntil: lockExpiry(existing, now),
        lockedBy: INSTANCE_ID,
        lastStatus: "running",
      },
    },
    { returnDocument: "after" },
  );
  if (!job) throw new JobBusyError("Job is already running");

  const { run } = await startRun(job, { trigger: "manual", triggeredBy });
  return run;
};

export const startScheduler = () => {
  if (String(process.env.SCHEDULER_ENABLED || "true") !== "true") {
    console.log("Scheduler disabled via SCHEDULER_ENABLED");
    return null;
  }

  let timer;
  let stopped = false;
  const loop = async () => {
    try {
      await tick();
    } catch (error) {
      console.error("Scheduler tick failed:", error.message);
    } finally {
      if (!stopped) timer = setTimeout(loop, TICK_MS);
    }
  };
  timer = setTimeout(loop, 5000);

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
