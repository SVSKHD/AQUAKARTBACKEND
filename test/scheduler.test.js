import test from "node:test";
import assert from "node:assert/strict";
import { nextCronRun, nextCronRuns, parseCron } from "../src/utils/cron.js";
import {
  computeNextRunAt,
  normalizeJobInput,
} from "../src/services/scheduler/schedule.js";
import { validateActionParams } from "../src/services/scheduler/actions.js";

const NOW = new Date("2026-10-23T10:00:00.000Z"); // Friday 15:30 IST

test("next daily run is computed in IST", () => {
  // 09:00 IST already passed today, so the next run is tomorrow 03:30 UTC.
  assert.equal(
    nextCronRun("0 9 * * *", NOW, "Asia/Kolkata").toISOString(),
    "2026-10-24T03:30:00.000Z",
  );
});

test("supports steps, ranges, names and macros", () => {
  assert.deepEqual(
    nextCronRuns("*/15 * * * *", 3, NOW, "UTC").map((d) => d.toISOString()),
    [
      "2026-10-23T10:15:00.000Z",
      "2026-10-23T10:30:00.000Z",
      "2026-10-23T10:45:00.000Z",
    ],
  );
  assert.equal(
    nextCronRun("30 8 * * MON-FRI", NOW, "UTC").toISOString(),
    "2026-10-26T08:30:00.000Z",
  );
  assert.equal(
    nextCronRun("@monthly", NOW, "UTC").toISOString(),
    "2026-11-01T00:00:00.000Z",
  );
  assert.equal(
    nextCronRun("0 0 * * 7", NOW, "UTC").toISOString(),
    "2026-10-25T00:00:00.000Z",
  );
});

test("day-of-month and day-of-week are OR-ed when both are restricted", () => {
  // The 1st of the month or any Monday, whichever comes first.
  assert.equal(
    nextCronRun("0 0 1 * MON", NOW, "UTC").toISOString(),
    "2026-10-26T00:00:00.000Z",
  );
});

test("handles DST timezones", () => {
  // US DST ends 2026-11-01; 9am New York is 13:00 UTC before, 14:00 after.
  const runs = nextCronRuns(
    "0 9 * * *",
    3,
    new Date("2026-10-31T00:00:00Z"),
    "America/New_York",
  ).map((d) => d.toISOString());
  assert.deepEqual(runs, [
    "2026-10-31T13:00:00.000Z",
    "2026-11-01T14:00:00.000Z",
    "2026-11-02T14:00:00.000Z",
  ]);
});

test("rejects invalid cron expressions", () => {
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /between 0 and 59/);
  assert.throws(() => parseCron("*/0 * * * *"), /step/);
  assert.equal(nextCronRun("0 0 30 2 *", NOW, "UTC"), null);
});

test("normalizes a valid cron job", () => {
  const { data, error } = normalizeJobInput(
    {
      name: " Daily tip ",
      action: "whatsapp.send",
      params: { to: "9876543210, 919876543211", message: "Hi" },
      scheduleType: "cron",
      cron: "0 9 * * *",
    },
    null,
    NOW,
  );
  assert.equal(error, undefined);
  assert.equal(data.name, "Daily tip");
  assert.deepEqual(data.params.to, ["9876543210", "919876543211"]);
  assert.equal(data.timezone, "Asia/Kolkata");
  assert.equal(data.enabled, true);
  assert.equal(
    computeNextRunAt(data, NOW).toISOString(),
    "2026-10-24T03:30:00.000Z",
  );
});

test("rejects bad job input", () => {
  const base = {
    name: "Job",
    action: "email.send",
    params: { to: ["a@b.co"], subject: "S", message: "M" },
    scheduleType: "interval",
    intervalMinutes: 30,
  };
  const errorFor = (patch) =>
    normalizeJobInput({ ...base, ...patch }, null, NOW).error;

  assert.equal(errorFor({}), undefined);
  assert.match(errorFor({ action: "quotation.followups" }), /reserved/);
  assert.match(errorFor({ action: "rm -rf" }), /Unknown action/);
  assert.match(errorFor({ intervalMinutes: 0 }), /intervalMinutes/);
  assert.match(errorFor({ scheduleType: "cron", cron: "bad" }), /5 fields/);
  assert.match(errorFor({ timezone: "Mars/Base" }), /timezone/);
  assert.match(
    errorFor({ scheduleType: "once", runAt: "2020-01-01T00:00:00Z" }),
    /future/,
  );
  assert.match(
    errorFor({ params: { to: ["nope"], subject: "S", message: "M" } }),
    /not valid/,
  );
});

test("built-in jobs keep their action on partial updates", () => {
  const existing = {
    name: "Quotation WhatsApp follow-ups",
    system: true,
    action: "quotation.followups",
    params: {},
    scheduleType: "cron",
    cron: "10 * * * *",
    timezone: "Asia/Kolkata",
    timeoutSeconds: 300,
    enabled: true,
  };
  const ok = normalizeJobInput({ cron: "*/30 * * * *" }, existing, NOW);
  assert.equal(ok.error, undefined);
  assert.equal(ok.data.cron, "*/30 * * * *");
  assert.match(
    normalizeJobInput({ action: "whatsapp.send" }, existing, NOW).error,
    /cannot be changed/,
  );
});

test("AI job needs at least one recipient", () => {
  assert.match(
    validateActionParams("ai.generate_and_notify", { prompt: "Tip" }).error,
    /at least one/,
  );
  assert.equal(
    validateActionParams("ai.generate_and_notify", {
      prompt: "Tip",
      emailTo: "team@aquakart.co.in",
    }).error,
    undefined,
  );
});
