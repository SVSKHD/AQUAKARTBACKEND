import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeQuota,
  dailyLimit,
  getQuota,
  isTestingMode,
  nextReset,
  quotaDay,
  quotaSubject,
  refundQuota,
} from "../src/services/aiQuota.js";

test("quota days roll over at midnight IST", () => {
  // 18:29 UTC = 23:59 IST on the 23rd; 18:30 UTC = 00:00 IST on the 24th.
  assert.equal(quotaDay(new Date("2026-10-23T18:29:00Z")), "2026-10-23");
  assert.equal(quotaDay(new Date("2026-10-23T18:30:00Z")), "2026-10-24");
  assert.equal(
    nextReset(new Date("2026-10-23T10:00:00Z")).toISOString(),
    "2026-10-23T18:30:00.000Z",
  );
  assert.equal(
    nextReset(new Date("2026-10-23T18:30:00Z")).toISOString(),
    "2026-10-24T18:30:00.000Z",
  );
});

test("guests get 3 questions and logged-in customers 5 by default", (t) => {
  t.after(() => {
    delete process.env.AI_GUEST_DAILY_LIMIT;
    delete process.env.AI_USER_DAILY_LIMIT;
  });
  assert.equal(dailyLimit("guest"), 3);
  assert.equal(dailyLimit("user"), 5);
  process.env.AI_GUEST_DAILY_LIMIT = "2";
  process.env.AI_USER_DAILY_LIMIT = "abc";
  assert.equal(dailyLimit("guest"), 2);
  assert.equal(dailyLimit("user"), 5);
});

test("guests are keyed by IP and customers by account", () => {
  assert.deepEqual(quotaSubject({ user: null, ip: "1.2.3.4" }), {
    tier: "guest",
    key: "ip:1.2.3.4",
    role: null,
  });
  assert.deepEqual(quotaSubject({ user: { _id: "u1" }, ip: "1.2.3.4" }), {
    tier: "user",
    key: "user:u1",
    role: null,
  });
});

test("admins and testers chat without a limit, on any environment", async () => {
  delete process.env.TESTING_MODE;
  const admin = quotaSubject({ user: { _id: "a1", role: 1 }, ip: "1.2.3.4" });
  const tester = quotaSubject({ user: { _id: "t1", role: 4 }, ip: "1.2.3.4" });
  const customer = quotaSubject({
    user: { _id: "c1", role: 2 },
    ip: "1.2.3.4",
  });
  const staff = quotaSubject({ user: { _id: "s1", role: 3 }, ip: "1.2.3.4" });
  assert.equal(admin.role, "admin");
  assert.equal(tester.role, "tester");
  assert.equal(customer.role, null);
  assert.equal(staff.role, null);

  // No database is connected here: an unlimited role must never query it.
  for (const [subject, access] of [
    [admin, "admin"],
    [tester, "tester"],
  ]) {
    const claim = await consumeQuota(subject);
    assert.equal(claim.allowed, true);
    assert.equal(claim.day, null);
    assert.equal(claim.quota.unlimited, true);
    assert.equal(claim.quota.access, access);
    assert.equal(claim.quota.testingMode, false);
    const quota = await getQuota(subject);
    assert.equal(quota.unlimited, true);
    assert.equal(quota.access, access);
    await refundQuota(subject, claim.day);
  }
});

test("TESTING_MODE=true makes the storefront quota unlimited without counting", async (t) => {
  t.after(() => delete process.env.TESTING_MODE);
  process.env.TESTING_MODE = "true";
  const subject = { tier: "guest", key: "ip:1.2.3.4" };
  // No database is connected here, so any query would hang or throw.
  const claim = await consumeQuota(subject);
  assert.equal(claim.allowed, true);
  assert.equal(claim.day, null);
  assert.equal(claim.quota.unlimited, true);
  assert.equal(claim.quota.testingMode, true);
  assert.equal(claim.quota.remaining, null);
  assert.equal((await getQuota(subject)).unlimited, true);
  await refundQuota(subject, claim.day);

  process.env.TESTING_MODE = "false";
  assert.equal(isTestingMode(), false);
});

test("a guest who logs in keeps today's guest questions, once", async (t) => {
  const { default: AiUsage } = await import("../src/models/aiUsage.js");
  const { carryGuestUsage } = await import("../src/services/aiQuota.js");
  const now = new Date("2026-10-23T10:00:00Z");
  const docs = new Map([["ip:1.2.3.4|2026-10-23", 3]]);
  const query = (count) => ({
    select: () => ({ lean: async () => (count == null ? null : { count }) }),
  });
  t.mock.method(AiUsage, "findOne", ({ key, day }) =>
    query(docs.get(`${key}|${day}`)),
  );
  const writes = [];
  t.mock.method(AiUsage, "updateOne", async (filter, update, opts) => {
    writes.push({ filter, update, opts });
    const k = `${filter.key}|${filter.day}`;
    if (!docs.has(k)) docs.set(k, update.$setOnInsert.count); // $setOnInsert semantics
  });

  const q = await carryGuestUsage({ _id: "u1" }, "1.2.3.4", now);
  assert.deepEqual(
    { tier: q.tier, limit: q.limit, used: q.used, remaining: q.remaining },
    { tier: "user", limit: 5, used: 3, remaining: 2 },
  );
  assert.equal(writes[0].filter.key, "user:u1");
  assert.equal(writes[0].update.$setOnInsert.count, 3);
  assert.equal(writes[0].opts.upsert, true);

  // Repeating it doesn't add the guest questions again.
  const again = await carryGuestUsage({ _id: "u1" }, "1.2.3.4", now);
  assert.equal(again.used, 3);

  // No guest usage from this IP: nothing is written.
  const fresh = await carryGuestUsage({ _id: "u2" }, "9.9.9.9", now);
  assert.equal(fresh.used, 0);
  assert.equal(writes.filter((w) => w.filter.key === "user:u2").length, 0);
});
