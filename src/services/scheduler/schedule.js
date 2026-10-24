import { isValidTimeZone, nextCronRun, parseCron } from "../../utils/cron.js";
import { ACTIONS, validateActionParams } from "./actions.js";

export const DEFAULT_TIMEZONE = "Asia/Kolkata";
export const SCHEDULE_FIELDS = [
  "scheduleType",
  "cron",
  "intervalMinutes",
  "runAt",
  "timezone",
  "enabled",
];
const MAX_INTERVAL_MINUTES = 366 * 24 * 60;

export const computeNextRunAt = (job, from = new Date()) => {
  if (job.scheduleType === "cron") {
    return nextCronRun(job.cron, from, job.timezone || DEFAULT_TIMEZONE);
  }
  if (job.scheduleType === "interval") {
    return new Date(from.getTime() + job.intervalMinutes * 60 * 1000);
  }
  if (job.scheduleType === "once") {
    return job.runAt && new Date(job.runAt) > from ? new Date(job.runAt) : null;
  }
  return null;
};

// Validates a create (existing = null) or partial update payload and returns
// { data } with every schedule/action field resolved, or { error }.
export const normalizeJobInput = (body, existing = null, now = new Date()) => {
  const input = body && typeof body === "object" ? body : {};
  const pick = (field) =>
    input[field] !== undefined ? input[field] : existing?.[field];
  const data = {};

  const name = pick("name");
  if (typeof name !== "string" || !name.trim()) {
    return { error: "name is required" };
  }
  if (name.trim().length > 120) {
    return { error: "name must be at most 120 characters" };
  }
  data.name = name.trim();

  if (input.description !== undefined) {
    if (typeof input.description !== "string") {
      return { error: "description must be a string" };
    }
    if (input.description.length > 1000) {
      return { error: "description must be at most 1000 characters" };
    }
    data.description = input.description.trim();
  }

  const action = pick("action");
  if (existing?.system && action !== existing.action) {
    return { error: "The action of a built-in job cannot be changed" };
  }
  if (!ACTIONS[action]) return { error: `Unknown action "${action}"` };
  if (ACTIONS[action].systemOnly && !existing?.system) {
    return { error: "This action is reserved for built-in jobs" };
  }
  data.action = action;

  const { params, error: paramsError } = validateActionParams(
    action,
    pick("params"),
  );
  if (paramsError) return { error: paramsError };
  data.params = params;

  const scheduleType = pick("scheduleType");
  if (!["cron", "interval", "once"].includes(scheduleType)) {
    return { error: "scheduleType must be one of cron, interval, once" };
  }
  data.scheduleType = scheduleType;
  data.cron = null;
  data.intervalMinutes = null;
  data.runAt = null;

  const timezone = pick("timezone") || DEFAULT_TIMEZONE;
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) {
    return { error: `Unknown timezone "${timezone}"` };
  }
  data.timezone = timezone;

  if (scheduleType === "cron") {
    const cron = typeof pick("cron") === "string" ? pick("cron").trim() : "";
    try {
      parseCron(cron);
    } catch (error) {
      return { error: error.message };
    }
    if (!nextCronRun(cron, now, timezone)) {
      return { error: "Cron expression never matches a real date" };
    }
    data.cron = cron;
  } else if (scheduleType === "interval") {
    const minutes = Number(pick("intervalMinutes"));
    if (
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > MAX_INTERVAL_MINUTES
    ) {
      return {
        error: `intervalMinutes must be a whole number between 1 and ${MAX_INTERVAL_MINUTES}`,
      };
    }
    data.intervalMinutes = minutes;
  } else {
    const runAt = new Date(pick("runAt"));
    if (!pick("runAt") || Number.isNaN(runAt.getTime())) {
      return { error: "runAt must be a valid date" };
    }
    data.runAt = runAt;
  }

  const timeoutSeconds = Number(pick("timeoutSeconds") ?? 300);
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 10 ||
    timeoutSeconds > 3600
  ) {
    return { error: "timeoutSeconds must be between 10 and 3600" };
  }
  data.timeoutSeconds = timeoutSeconds;

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return { error: "enabled must be true or false" };
  }
  data.enabled = pick("enabled") ?? true;

  if (data.enabled && scheduleType === "once" && data.runAt <= now) {
    return { error: "runAt must be in the future" };
  }

  return { data };
};
