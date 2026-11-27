import assert from "node:assert/strict";
import test from "node:test";
import Draft from "../src/models/crm/easyInvoiceDraft.js";
import Drafts from "../src/controllers/crm/easyInvoiceDrafts.js";
import {
  LOCK_TTL_MS,
  claimPlan,
  cleanContent,
  cleanDevice,
  draftSummary,
  lockState,
  publicDraft,
  touchDevice,
} from "../src/services/crm/easyInvoiceDrafts.js";

const ID = "6710a1b2c3d4e5f6a7b8c9d0";
const RAVI = {
  _id: "64b000000000000000000001",
  firstName: "Ravi",
  lastName: "K",
};
const SITA = { _id: "64b000000000000000000002", firstName: "Sita" };
const PHONE = { deviceId: "phone-device-1", deviceLabel: "iPhone · Safari" };
const LAPTOP = { deviceId: "laptop-device-1", deviceLabel: "Windows · Chrome" };

const response = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});
const lean = (value) => ({ lean: async () => value });

const draftHeldBy = (user, device, ageMs = 1000) => ({
  _id: ID,
  status: "open",
  rev: 3,
  content: {
    rawText: "hithesh svsk\nkent 25l 65000",
    doc: {
      customer: { name: "Hithesh Svsk", phone: "9876543210" },
      lines: [
        { price: "65000", quantity: 1 },
        { price: "", quantity: 2 },
      ],
    },
  },
  createdBy: { name: "Ravi K" },
  updatedBy: { name: "Ravi K" },
  devices: [
    {
      deviceId: device.deviceId,
      label: device.deviceLabel,
      name: "Ravi K",
      adminId: user._id,
      lastSeenAt: new Date(),
    },
  ],
  editor: {
    adminId: user._id,
    name: "Ravi K",
    deviceId: device.deviceId,
    deviceLabel: device.deviceLabel,
    since: new Date(Date.now() - 60_000),
    heartbeatAt: new Date(Date.now() - ageMs),
  },
  events: [],
});

test("device and content are validated", () => {
  assert.deepEqual(cleanDevice(PHONE), {
    deviceId: "phone-device-1",
    label: "iPhone · Safari",
  });
  assert.throws(() => cleanDevice({ deviceId: "x" }), /deviceId/);
  assert.throws(() => cleanContent([]), /object/);
  assert.throws(
    () => cleanContent({ rawText: "x".repeat(70 * 1024) }),
    (error) => error.status === 413,
  );
});

test("lock is live only within the TTL and belongs to one device", () => {
  const fresh = draftHeldBy(RAVI, PHONE);
  assert.equal(lockState(fresh, RAVI, PHONE.deviceId).mine, true);
  // Same staff, other device: not mine.
  assert.equal(lockState(fresh, RAVI, LAPTOP.deviceId).mine, false);
  assert.equal(lockState(fresh, SITA, LAPTOP.deviceId).live, true);
  const stale = draftHeldBy(RAVI, PHONE, LOCK_TTL_MS + 1);
  assert.equal(lockState(stale, SITA, LAPTOP.deviceId).live, false);
});

test("claim: free or stale is taken, live needs force and records a takeover", () => {
  const device = cleanDevice(LAPTOP);
  assert.equal(
    claimPlan(draftHeldBy(RAVI, PHONE, LOCK_TTL_MS + 1), SITA, device, false)
      .event,
    "claimed",
  );
  assert.throws(
    () => claimPlan(draftHeldBy(RAVI, PHONE), SITA, device, false),
    (error) =>
      error.code === "DRAFT_LOCKED" &&
      error.details.editor.name === "Ravi K" &&
      error.details.editor.deviceLabel === "iPhone · Safari",
  );
  const plan = claimPlan(draftHeldBy(RAVI, PHONE), SITA, device, true);
  assert.equal(plan.event, "taken_over");
  assert.equal(plan.from.name, "Ravi K");
  assert.throws(
    () =>
      claimPlan(
        { ...draftHeldBy(RAVI, PHONE), status: "done" },
        SITA,
        device,
        true,
      ),
    (error) => error.code === "DRAFT_CLOSED",
  );
});

test("devices list keeps one entry per device, newest first", () => {
  const first = touchDevice([], cleanDevice(PHONE), RAVI, new Date(1));
  const both = touchDevice(first, cleanDevice(LAPTOP), SITA, new Date(2));
  const again = touchDevice(both, cleanDevice(PHONE), RAVI, new Date(3));
  assert.deepEqual(
    again.map((device) => device.label),
    ["iPhone · Safari", "Windows · Chrome"],
  );
  assert.equal(again[0].firstSeenAt.getTime(), 1);
  assert.equal(again[0].lastSeenAt.getTime(), 3);
});

test("summary reads title, items and total from the page state", () => {
  assert.deepEqual(draftSummary(draftHeldBy(RAVI, PHONE).content), {
    title: "Hithesh Svsk",
    phone: "9876543210",
    itemCount: 2,
    total: 65000,
  });
  assert.equal(
    draftSummary({ rawText: "\n  first line  \nx" }).title,
    "first line",
  );
  assert.equal(draftSummary({}).title, "Untitled draft");
});

test("public draft hides device ids and flags this device", () => {
  const view = publicDraft(draftHeldBy(RAVI, PHONE), SITA, LAPTOP.deviceId);
  assert.equal(view.lock.mine, false);
  assert.equal(view.lock.editor.name, "Ravi K");
  assert.equal(view.devices[0].thisDevice, false);
  assert.equal(JSON.stringify(view).includes("phone-device-1"), false);
  assert.equal(view.content, undefined);
});

test("saving someone else's draft is refused with who is editing", async (t) => {
  t.mock.method(Draft, "findOneAndUpdate", () => lean(null));
  t.mock.method(Draft, "findById", () => lean(draftHeldBy(RAVI, PHONE)));
  const res = response();
  await Drafts.save(
    {
      user: SITA,
      params: { id: ID },
      body: { ...LAPTOP, content: { rawText: "x" } },
    },
    res,
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "DRAFT_LOCKED");
  assert.equal(res.body.details.editor.deviceLabel, "iPhone · Safari");
});

test("taking over a live draft records the takeover for the old editor", async (t) => {
  let update;
  t.mock.method(Draft, "findById", () => lean(draftHeldBy(RAVI, PHONE)));
  t.mock.method(Draft, "findOneAndUpdate", (filter, body) => {
    assert.deepEqual(filter, { _id: ID, rev: 3 });
    update = body;
    const next = draftHeldBy(SITA, LAPTOP);
    next.events = body.$push.events.$each;
    return lean(next);
  });
  const res = response();
  await Drafts.claim(
    { user: SITA, params: { id: ID }, body: { ...LAPTOP, force: true } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(update.$set.editor.name, "Sita");
  const [event] = update.$push.events.$each;
  assert.equal(event.type, "taken_over");
  assert.equal(event.fromName, "Ravi K");
  assert.equal(event.fromDeviceId, "phone-device-1");
  assert.equal(res.body.data.lock.mine, true);
  // The old editor's device sees it was taken from them.
  const seenByRavi = publicDraft(
    { ...draftHeldBy(SITA, LAPTOP), events: update.$push.events.$each },
    RAVI,
    PHONE.deviceId,
  );
  assert.equal(seenByRavi.events[0].fromThisDevice, true);
  assert.equal(seenByRavi.lock.mine, false);
});

test("claim without force on a live draft is refused", async (t) => {
  t.mock.method(Draft, "findById", () => lean(draftHeldBy(RAVI, PHONE)));
  t.mock.method(Draft, "findOneAndUpdate", () => {
    throw new Error("must not write");
  });
  const res = response();
  await Drafts.claim({ user: SITA, params: { id: ID }, body: LAPTOP }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "DRAFT_LOCKED");
});

test("heartbeat from a viewer returns content only when it changed", async (t) => {
  t.mock.method(Draft, "findOneAndUpdate", () => lean(null));
  t.mock.method(Draft, "findById", () => lean(draftHeldBy(RAVI, PHONE)));
  const same = response();
  await Drafts.heartbeat(
    { user: SITA, params: { id: ID }, body: { ...LAPTOP, knownRev: 3 } },
    same,
  );
  assert.equal(same.body.data.content, undefined);
  const changed = response();
  await Drafts.heartbeat(
    { user: SITA, params: { id: ID }, body: { ...LAPTOP, knownRev: 2 } },
    changed,
  );
  assert.equal(changed.body.data.content.doc.customer.name, "Hithesh Svsk");
});

test("discarding a draft someone else is editing is refused", async (t) => {
  t.mock.method(Draft, "findById", () => lean(draftHeldBy(RAVI, PHONE)));
  const res = response();
  await Drafts.discard(
    { user: SITA, params: { id: ID }, body: LAPTOP, query: {} },
    res,
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "DRAFT_LOCKED");
});

test("list returns open drafts for every staff member", async (t) => {
  t.mock.method(Draft, "find", (filter) => {
    assert.deepEqual(filter, { status: "open" });
    return {
      sort: () => ({ limit: () => lean([draftHeldBy(RAVI, PHONE)]) }),
    };
  });
  const res = response();
  await Drafts.list({ user: SITA, query: LAPTOP }, res);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].title, "Hithesh Svsk");
  assert.equal(res.body.data[0].lock.live, true);
});
