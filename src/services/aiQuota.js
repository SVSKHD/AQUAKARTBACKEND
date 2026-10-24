import AiUsage from "../models/aiUsage.js";

// Storefront AI daily allowance: guests are counted per IP, logged-in
// customers per account. Days roll over at midnight IST. CRM is unlimited.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const positiveEnv = (name, fallback) => {
  const value = Math.trunc(Number(process.env[name]));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// TESTING_MODE=true switches the storefront quota off entirely (no counting,
// no DB writes). Only for testing; never leave it on in production.
export const isTestingMode = () =>
  String(process.env.TESTING_MODE || "").toLowerCase() === "true";

const unlimitedQuota = (subject, now) => ({
  tier: subject.tier,
  limit: null,
  used: 0,
  remaining: null,
  unlimited: true,
  testingMode: true,
  resetsAt: nextReset(now).toISOString(),
});

export const dailyLimit = (tier) =>
  tier === "user"
    ? positiveEnv("AI_USER_DAILY_LIMIT", 5)
    : positiveEnv("AI_GUEST_DAILY_LIMIT", 3);

export const quotaDay = (now = new Date()) =>
  new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export const nextReset = (now = new Date()) => {
  const istMidnight =
    Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return new Date(istMidnight + DAY_MS - IST_OFFSET_MS);
};

export const quotaSubject = (req) =>
  req.user
    ? { tier: "user", key: `user:${req.user._id}` }
    : { tier: "guest", key: `ip:${req.ip}` };

const describe = (subject, used, now) => {
  const limit = dailyLimit(subject.tier);
  return {
    tier: subject.tier,
    limit,
    used: Math.min(used, limit),
    remaining: Math.max(0, limit - used),
    resetsAt: nextReset(now).toISOString(),
  };
};

export const getQuota = async (subject, now = new Date()) => {
  if (isTestingMode()) return unlimitedQuota(subject, now);
  const usage = await AiUsage.findOne({ key: subject.key, day: quotaDay(now) })
    .select("count")
    .lean();
  return describe(subject, usage?.count || 0, now);
};

// Atomically takes one question from today's allowance.
// Returns { allowed, quota, day }; `day` is needed to refund.
export const consumeQuota = async (subject, now = new Date()) => {
  if (isTestingMode()) {
    return { allowed: true, day: null, quota: unlimitedQuota(subject, now) };
  }
  const day = quotaDay(now);
  const limit = dailyLimit(subject.tier);

  // Two attempts: concurrent first requests of the day can collide on the
  // upsert's unique index even when under the limit.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const usage = await AiUsage.findOneAndUpdate(
        { key: subject.key, day, count: { $lt: limit } },
        {
          $inc: { count: 1 },
          $setOnInsert: {
            tier: subject.tier,
            expiresAt: new Date(nextReset(now).getTime() + DAY_MS),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      return { allowed: true, day, quota: describe(subject, usage.count, now) };
    } catch (error) {
      // The day's document exists and is already at the limit.
      if (error?.code !== 11000) throw error;
    }
  }
  return { allowed: false, day, quota: describe(subject, limit, now) };
};

// A guest who logs in mid-chat keeps the questions they already used today:
// the account's day starts from the IP's guest count (capped at the account
// limit). Only seeds a day the account hasn't used yet, so it runs once per day
// and can't be repeated to change the count. Called only when the client says
// this browser chatted as a guest, so shared IPs don't penalise other customers.
export const carryGuestUsage = async (user, ip, now = new Date()) => {
  const subject = { tier: "user", key: `user:${user._id}` };
  if (isTestingMode()) return unlimitedQuota(subject, now);
  const day = quotaDay(now);
  const guest = await AiUsage.findOne({ key: `ip:${ip}`, day })
    .select("count")
    .lean();
  const carried = Math.min(guest?.count || 0, dailyLimit("user"));
  if (carried > 0) {
    try {
      await AiUsage.updateOne(
        { key: subject.key, day },
        {
          $setOnInsert: {
            tier: "user",
            count: carried,
            expiresAt: new Date(nextReset(now).getTime() + DAY_MS),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // Created concurrently by the user's first question: nothing to seed.
      if (error?.code !== 11000) throw error;
    }
  }
  return getQuota(subject, now);
};

export const refundQuota = async (subject, day) => {
  if (!day) return; // nothing was counted (testing mode)
  await AiUsage.updateOne(
    { key: subject.key, day, count: { $gt: 0 } },
    { $inc: { count: -1 } },
  );
};
