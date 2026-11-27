/*
 * Easy invoice drafts: validation, the one-editor lock and list summaries.
 * Pure functions only; the controller does the database work.
 */

/** A lock without a heartbeat for this long is free to take. */
export const LOCK_TTL_MS = 45_000;
export const MAX_CONTENT_BYTES = 64 * 1024;
export const MAX_DEVICES = 20;
export const MAX_EVENTS = 30;
export const EVENTS_SHOWN = 10;
export const LIST_LIMIT = 50;

export class DraftError extends Error {
  constructor(message, status = 400, code = "INVALID", details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const OBJECT_ID = /^[a-f\d]{24}$/i;

const cleanText = (value, max) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export const assertDraftId = (id) => {
  if (!OBJECT_ID.test(String(id || "")))
    throw new DraftError("Invalid draft id", 400, "INVALID_ID");
  return String(id);
};

/** { deviceId, label } from the request body or query. */
export const cleanDevice = (source = {}) => {
  const deviceId = String(source.deviceId ?? "").trim();
  if (!DEVICE_ID.test(deviceId))
    throw new DraftError("A valid deviceId is required", 400, "INVALID_DEVICE");
  return {
    deviceId,
    label:
      cleanText(source.deviceLabel ?? source.label, 80) || "Unknown device",
  };
};

/** The page state; a plain object no bigger than MAX_CONTENT_BYTES. */
export const cleanContent = (content) => {
  if (!content || typeof content !== "object" || Array.isArray(content))
    throw new DraftError("content must be an object", 400, "INVALID_CONTENT");
  const json = JSON.stringify(content);
  if (Buffer.byteLength(json, "utf8") > MAX_CONTENT_BYTES)
    throw new DraftError(
      "The draft is too large to save",
      413,
      "CONTENT_TOO_LARGE",
    );
  return JSON.parse(json);
};

export const staffName = (user = {}) =>
  cleanText(
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.name ||
      user.email ||
      "Staff",
    80,
  );

export const staffRef = (user = {}) => ({
  adminId: user._id,
  name: staffName(user),
});

const sameId = (a, b) => Boolean(a && b) && String(a) === String(b);

export const lockIsLive = (editor, now = Date.now()) =>
  Boolean(editor?.heartbeatAt) &&
  now - new Date(editor.heartbeatAt).getTime() < LOCK_TTL_MS;

/** Who holds the draft right now, from this staff member's device. */
export const lockState = (draft, user, deviceId, now = Date.now()) => {
  const editor = draft?.editor;
  const live = lockIsLive(editor, now);
  const mine =
    live && sameId(editor.adminId, user?._id) && editor.deviceId === deviceId;
  return { live, mine, editor: live ? editor : null };
};

/**
 * Can this device take the draft? Throws when it can't; otherwise says
 * which event to record ("claimed", "taken_over", or none when it's ours).
 */
export const claimPlan = (draft, user, device, force, now = Date.now()) => {
  if (draft.status !== "open")
    throw new DraftError("This draft is closed", 409, "DRAFT_CLOSED");
  const lock = lockState(draft, user, device.deviceId, now);
  if (lock.mine) return { event: null };
  if (!lock.live) return { event: "claimed" };
  if (!force)
    throw new DraftError(
      `${lock.editor.name || "Someone"} is editing this draft`,
      409,
      "DRAFT_LOCKED",
      { editor: publicEditor(lock.editor, user, device.deviceId) },
    );
  return { event: "taken_over", from: lock.editor };
};

/** Records the device; newest first, capped. */
export const touchDevice = (devices = [], device, user, now = new Date()) => {
  const existing = devices.find((entry) => entry.deviceId === device.deviceId);
  const entry = {
    deviceId: device.deviceId,
    label: device.label,
    adminId: user._id,
    name: staffName(user),
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
  };
  return [
    entry,
    ...devices.filter((item) => item.deviceId !== device.deviceId),
  ].slice(0, MAX_DEVICES);
};

export const editorFor = (user, device, now = new Date(), since = now) => ({
  adminId: user._id,
  name: staffName(user),
  deviceId: device.deviceId,
  deviceLabel: device.label,
  since,
  heartbeatAt: now,
});

export const eventFor = (
  type,
  user,
  device,
  now = new Date(),
  from = null,
) => ({
  type,
  adminId: user._id,
  name: staffName(user),
  deviceId: device.deviceId,
  deviceLabel: device.label,
  fromName: from?.name || "",
  fromDeviceId: from?.deviceId || "",
  at: now,
});

export const withEvent = (events = [], event) =>
  [...events, event].slice(-MAX_EVENTS);

/* ---------- what the CRM gets back ---------- */

const linePrice = (line) => {
  const value = Number(String(line?.price ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** Title, item count and total, read from the CRM page state. */
export const draftSummary = (content = {}) => {
  const doc =
    content?.doc && typeof content.doc === "object" ? content.doc : {};
  const lines = Array.isArray(doc.lines) ? doc.lines : [];
  const firstLine = String(content?.rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const total = lines.reduce(
    (sum, line) =>
      sum + linePrice(line) * Math.max(Number(line?.quantity) || 0, 0),
    0,
  );
  return {
    title:
      cleanText(doc.customer?.name, 60) ||
      cleanText(firstLine, 60) ||
      "Untitled draft",
    phone: cleanText(doc.customer?.phone, 20),
    itemCount: lines.length,
    total: Math.round(total * 100) / 100,
  };
};

export const publicEditor = (editor, user, deviceId) =>
  editor
    ? {
        name: editor.name,
        deviceLabel: editor.deviceLabel,
        since: editor.since,
        heartbeatAt: editor.heartbeatAt,
        sameStaff: sameId(editor.adminId, user?._id),
        thisDevice: editor.deviceId === deviceId,
      }
    : null;

export const publicDraft = (
  draft,
  user,
  deviceId,
  { withContent = false, now = Date.now() } = {},
) => {
  const lock = lockState(draft, user, deviceId, now);
  return {
    id: String(draft._id),
    status: draft.status,
    rev: draft.rev || 0,
    invoiceId: draft.invoiceId || "",
    ...draftSummary(draft.content),
    createdBy: { name: draft.createdBy?.name || "" },
    updatedBy: { name: draft.updatedBy?.name || "" },
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    devices: (draft.devices || []).map((device) => ({
      label: device.label,
      name: device.name,
      lastSeenAt: device.lastSeenAt,
      firstSeenAt: device.firstSeenAt,
      thisDevice: device.deviceId === deviceId,
    })),
    lock: {
      live: lock.live,
      mine: lock.mine,
      editor: publicEditor(lock.editor, user, deviceId),
    },
    events: (draft.events || [])
      .slice(-EVENTS_SHOWN)
      .reverse()
      .map((event) => ({
        type: event.type,
        name: event.name,
        deviceLabel: event.deviceLabel,
        fromName: event.fromName,
        at: event.at,
        byThisDevice: event.deviceId === deviceId,
        fromThisDevice:
          Boolean(event.fromDeviceId) && event.fromDeviceId === deviceId,
      })),
    ...(withContent ? { content: draft.content || {} } : {}),
  };
};
