import Draft from "../../models/crm/easyInvoiceDraft.js";
import {
  DraftError,
  LIST_LIMIT,
  LOCK_TTL_MS,
  MAX_EVENTS,
  assertDraftId,
  claimPlan,
  cleanContent,
  cleanDevice,
  editorFor,
  eventFor,
  lockState,
  publicDraft,
  publicEditor,
  staffRef,
  touchDevice,
} from "../../services/crm/easyInvoiceDrafts.js";

const handle = (action) => async (req, res) => {
  try {
    return await action(req, res);
  } catch (error) {
    if (error instanceof DraftError)
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    console.error("Easy invoice draft error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to manage the draft" });
  }
};

const load = async (id) => {
  const draft = await Draft.findById(assertDraftId(id)).lean();
  if (!draft) throw new DraftError("Draft not found", 404, "NOT_FOUND");
  return draft;
};

/** Compare-and-set on rev, so two lock changes can't both win. */
const casUpdate = async (draft, update) => {
  const next = await Draft.findOneAndUpdate(
    { _id: draft._id, rev: draft.rev || 0 },
    { ...update, $inc: { rev: 1 } },
    { new: true },
  ).lean();
  if (!next)
    throw new DraftError(
      "The draft changed at the same moment. Try again.",
      409,
      "DRAFT_BUSY",
    );
  return next;
};

/** Filter matching an open draft whose live lock is held by this device. */
const heldBy = (id, user, device, now) => ({
  _id: id,
  status: "open",
  "editor.adminId": user._id,
  "editor.deviceId": device.deviceId,
  "editor.heartbeatAt": { $gte: new Date(now - LOCK_TTL_MS) },
});

/** Why a lock-holder write failed: closed, gone, or someone else has it. */
const lockFailure = async (id, user, device) => {
  const draft = await load(id);
  if (draft.status !== "open")
    return new DraftError("This draft is closed", 409, "DRAFT_CLOSED");
  const lock = lockState(draft, user, device.deviceId);
  return new DraftError(
    lock.live
      ? `${lock.editor.name || "Someone"} is editing this draft`
      : "You're no longer editing this draft. Open it again to continue.",
    409,
    lock.live ? "DRAFT_LOCKED" : "LOCK_EXPIRED",
    { editor: publicEditor(lock.editor, user, device.deviceId) },
  );
};

const pushEvent = (event) => ({
  events: { $each: [event], $slice: -MAX_EVENTS },
});

const reply = (res, draft, req, device, options = {}, status = 200) =>
  res.status(status).json({
    success: true,
    data: publicDraft(draft, req.user, device.deviceId, options),
  });

export default {
  list: handle(async (req, res) => {
    const device = cleanDevice(req.query);
    const drafts = await Draft.find({ status: "open" })
      .sort({ updatedAt: -1 })
      .limit(LIST_LIMIT)
      .lean();
    return res.json({
      success: true,
      data: drafts.map((draft) =>
        publicDraft(draft, req.user, device.deviceId),
      ),
      serverTime: new Date().toISOString(),
    });
  }),

  create: handle(async (req, res) => {
    const device = cleanDevice(req.body);
    const content = cleanContent(req.body?.content);
    const now = new Date();
    const draft = await Draft.create({
      content,
      createdBy: staffRef(req.user),
      updatedBy: staffRef(req.user),
      devices: touchDevice([], device, req.user, now),
      editor: editorFor(req.user, device, now),
      events: [eventFor("created", req.user, device, now)],
    });
    return reply(
      res,
      draft.toObject(),
      req,
      device,
      { withContent: true },
      201,
    );
  }),

  get: handle(async (req, res) => {
    const device = cleanDevice(req.query);
    return reply(res, await load(req.params.id), req, device, {
      withContent: true,
    });
  }),

  /** Lock holder only. Saving also keeps the lock alive. */
  save: handle(async (req, res) => {
    const id = assertDraftId(req.params.id);
    const device = cleanDevice(req.body);
    const content = cleanContent(req.body?.content);
    const now = Date.now();
    const draft = await Draft.findOneAndUpdate(
      heldBy(id, req.user, device, now),
      {
        $set: {
          content,
          updatedBy: staffRef(req.user),
          "editor.heartbeatAt": new Date(now),
          "devices.$[d].lastSeenAt": new Date(now),
        },
        $inc: { rev: 1 },
      },
      { new: true, arrayFilters: [{ "d.deviceId": device.deviceId }] },
    ).lean();
    if (!draft) throw await lockFailure(id, req.user, device);
    return reply(res, draft, req, device);
  }),

  /**
   * Holder: keeps the lock alive. Anyone else: reads who is editing. With
   * knownRev, content comes back only when it changed since then.
   */
  heartbeat: handle(async (req, res) => {
    const id = assertDraftId(req.params.id);
    const device = cleanDevice(req.body);
    const now = Date.now();
    let draft = await Draft.findOneAndUpdate(
      heldBy(id, req.user, device, now),
      {
        $set: {
          "editor.heartbeatAt": new Date(now),
          "devices.$[d].lastSeenAt": new Date(now),
        },
      },
      { new: true, arrayFilters: [{ "d.deviceId": device.deviceId }] },
    ).lean();
    if (!draft) draft = await load(id);
    const knownRev = Number(req.body?.knownRev);
    return reply(res, draft, req, device, {
      withContent: !Number.isFinite(knownRev) || knownRev !== (draft.rev || 0),
    });
  }),

  /** Take the draft: free or stale locks always; a live one only with force. */
  claim: handle(async (req, res) => {
    const device = cleanDevice(req.body);
    const draft = await load(req.params.id);
    const now = new Date();
    const plan = claimPlan(
      draft,
      req.user,
      device,
      req.body?.force === true,
      now.getTime(),
    );
    const keepSince = plan.event === null ? draft.editor?.since : now;
    const next = await casUpdate(draft, {
      $set: {
        editor: editorFor(req.user, device, now, keepSince || now),
        devices: touchDevice(draft.devices, device, req.user, now),
      },
      ...(plan.event
        ? {
            $push: pushEvent(
              eventFor(plan.event, req.user, device, now, plan.from),
            ),
          }
        : {}),
    });
    return reply(res, next, req, device, { withContent: true });
  }),

  release: handle(async (req, res) => {
    const id = assertDraftId(req.params.id);
    const device = cleanDevice(req.body);
    const now = Date.now();
    const draft = await Draft.findOneAndUpdate(
      heldBy(id, req.user, device, now),
      {
        $set: { editor: null },
        $push: pushEvent(eventFor("released", req.user, device, new Date(now))),
        $inc: { rev: 1 },
      },
      { new: true },
    ).lean();
    // Releasing a lock you no longer hold is not an error.
    return reply(res, draft || (await load(id)), req, device);
  }),

  /** After the invoice is created from it. Lock holder only. */
  complete: handle(async (req, res) => {
    const id = assertDraftId(req.params.id);
    const device = cleanDevice(req.body);
    const invoiceId = String(req.body?.invoiceId ?? "")
      .trim()
      .slice(0, 64);
    if (!invoiceId)
      throw new DraftError("invoiceId is required", 400, "INVALID_INVOICE");
    const now = Date.now();
    const draft = await Draft.findOneAndUpdate(
      heldBy(id, req.user, device, now),
      {
        $set: {
          status: "done",
          invoiceId,
          editor: null,
          updatedBy: staffRef(req.user),
        },
        $push: pushEvent(
          eventFor("completed", req.user, device, new Date(now)),
        ),
        $inc: { rev: 1 },
      },
      { new: true },
    ).lean();
    if (!draft) throw await lockFailure(id, req.user, device);
    return reply(res, draft, req, device);
  }),

  /** Anyone may discard a draft nobody else is editing. */
  discard: handle(async (req, res) => {
    const device = cleanDevice({ ...req.query, ...req.body });
    const draft = await load(req.params.id);
    if (draft.status !== "open")
      throw new DraftError("This draft is closed", 409, "DRAFT_CLOSED");
    const lock = lockState(draft, req.user, device.deviceId);
    if (lock.live && !lock.mine)
      throw new DraftError(
        `${lock.editor.name || "Someone"} is editing this draft`,
        409,
        "DRAFT_LOCKED",
        { editor: publicEditor(lock.editor, req.user, device.deviceId) },
      );
    const next = await casUpdate(draft, {
      $set: {
        status: "discarded",
        editor: null,
        updatedBy: staffRef(req.user),
      },
      $push: pushEvent(eventFor("discarded", req.user, device, new Date())),
    });
    return reply(res, next, req, device);
  }),
};
