import mongoose from "mongoose";
import AiInvoiceSession, {
  SESSION_TTL_MS,
} from "../../models/crm/aiInvoiceSession.js";
import AquaProduct from "../../models/product.js";
import { GeminiError, THINKING_LEVELS } from "../../services/gemini.js";
import { runAgentTurn } from "../../services/aiInvoice/agent.js";
import {
  MAX_ITEMS,
  applyDraftPatch,
  buildItem,
  describeDraft,
  emptyDraft,
} from "../../services/aiInvoice/draft.js";
import {
  createInvoiceFromSession,
  emailSessionInvoice,
  searchCatalog,
  validateWithStock,
} from "../../services/aiInvoice/tools.js";

const MAX_MESSAGE_CHARS = 4000;
const MAX_TURNS = 40;
const LOCK_MS = 2 * 60 * 1000;

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const sessionView = async (session) => {
  const validation =
    session.status === "drafting"
      ? await validateWithStock(session.draft)
      : null;
  return {
    id: String(session._id),
    status: session.status,
    turn: session.turn,
    draftVersion: session.draftVersion,
    draft: describeDraft(session.draft, validation),
    awaitingConfirmation: Boolean(
      session.review?.version === session.draftVersion && !session.invoice,
    ),
    invoice: session.invoice,
    messages: session.transcript,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

const thinkingLevel = (value) => {
  if (value === true) return "medium";
  return THINKING_LEVELS.includes(value) ? value : null;
};

const validateMessage = (message) => {
  if (typeof message !== "string" || !message.trim()) {
    return "message is required";
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return `message must be at most ${MAX_MESSAGE_CHARS} characters`;
  }
  return null;
};

// Claims the session for one mutating request so concurrent messages or
// double-clicked "Create" buttons can't race each other.
const acquireSession = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 400, "Invalid session id");
    return null;
  }
  const now = new Date();
  const session = await AiInvoiceSession.findOneAndUpdate(
    {
      _id: req.params.id,
      staff: req.user._id,
      $or: [{ busyUntil: null }, { busyUntil: { $lt: now } }],
    },
    { $set: { busyUntil: new Date(now.getTime() + LOCK_MS) } },
    { returnDocument: "after" },
  );
  if (session) return session;

  const exists = await AiInvoiceSession.exists({
    _id: req.params.id,
    staff: req.user._id,
  });
  if (exists) {
    fail(res, 409, "The assistant is still working on the previous request");
  } else {
    fail(res, 404, "Session not found");
  }
  return null;
};

const release = async (session) => {
  session.busyUntil = null;
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await session.save();
};

const sendAgentError = (res, error) => {
  if (error instanceof GeminiError)
    return fail(res, error.status, error.message);
  console.error("AI invoice assistant error:", error);
  return fail(res, 500, "The invoice assistant failed. Please try again.");
};

const runTurn = async (req, res, session, status = 200) => {
  if (session.status !== "drafting" && !session.invoice) {
    await release(session);
    return fail(res, 409, "This session is closed");
  }
  if (session.turn >= MAX_TURNS) {
    await release(session);
    return fail(
      res,
      409,
      "This conversation is too long. Start a new session.",
    );
  }

  // Work on a snapshot so a failed Gemini call leaves the session unchanged.
  const snapshot = session.toObject();
  try {
    const result = await runAgentTurn(session, req.body.message.trim(), {
      thinking: thinkingLevel(req.body.thinking),
      req,
    });
    await release(session);
    return res
      .status(status)
      .json({ success: true, data: await sessionView(session), turn: result });
  } catch (error) {
    session.set({
      draft: snapshot.draft,
      draftVersion: snapshot.draftVersion,
      review: snapshot.review,
      knownProducts: snapshot.knownProducts,
      contents: snapshot.contents,
      transcript: snapshot.transcript,
      turn: snapshot.turn,
    });
    // Keep an invoice that a tool already created before the failure.
    await release(session).catch(() => {});
    return sendAgentError(res, error);
  }
};

const createSession = async (req, res) => {
  const message = req.body?.message;
  if (message !== undefined) {
    const invalid = validateMessage(message);
    if (invalid) return fail(res, 400, invalid);
  }
  try {
    const session = await AiInvoiceSession.create({
      staff: req.user._id,
      draft: emptyDraft(),
      busyUntil: message ? new Date(Date.now() + LOCK_MS) : null,
    });
    if (!message) {
      return res
        .status(201)
        .json({ success: true, data: await sessionView(session) });
    }
    return runTurn(req, res, session, 201);
  } catch (error) {
    return sendAgentError(res, error);
  }
};

const listSessions = async (req, res) => {
  try {
    const sessions = await AiInvoiceSession.find({ staff: req.user._id })
      .sort({ updatedAt: -1 })
      .limit(20)
      .select(
        "status draft.customer.name invoice.invoiceNo turn updatedAt createdAt",
      )
      .lean();
    return res.json({
      success: true,
      data: sessions.map((session) => ({
        id: String(session._id),
        status: session.status,
        customerName: session.draft?.customer?.name || "",
        invoiceNo: session.invoice?.invoiceNo || null,
        turn: session.turn,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
    });
  } catch (error) {
    return sendAgentError(res, error);
  }
};

const getSession = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return fail(res, 400, "Invalid session id");
  }
  try {
    const session = await AiInvoiceSession.findOne({
      _id: req.params.id,
      staff: req.user._id,
    });
    if (!session) return fail(res, 404, "Session not found");
    return res.json({ success: true, data: await sessionView(session) });
  } catch (error) {
    return sendAgentError(res, error);
  }
};

const sendMessage = async (req, res) => {
  const invalid = validateMessage(req.body?.message);
  if (invalid) return fail(res, 400, invalid);
  try {
    const session = await acquireSession(req, res);
    if (!session) return undefined;
    return runTurn(req, res, session);
  } catch (error) {
    return sendAgentError(res, error);
  }
};

// Resolves CRM form items. Catalog items are looked up by productId so the
// name, slug and catalog price always come from the database.
const resolveItems = async (items) => {
  if (!Array.isArray(items)) return { error: "items must be an array" };
  if (items.length > MAX_ITEMS) {
    return { error: `An invoice can have at most ${MAX_ITEMS} items` };
  }
  const ids = items
    .map((item) => item?.productId)
    .filter((id) => id && mongoose.isValidObjectId(id));
  const products = await AquaProduct.find({ _id: { $in: ids } })
    .select(
      "title price discountPrice discountPriceStatus slug seoSlug ShortName code",
    )
    .lean();
  const byId = new Map(
    products.map((product) => [String(product._id), product]),
  );

  const resolved = [];
  for (const [index, item] of items.entries()) {
    if (item?.productId) {
      const product = byId.get(String(item.productId));
      if (!product) return { error: `Item ${index + 1}: product not found` };
      const sellingPrice =
        product.discountPriceStatus && Number(product.discountPrice) > 0
          ? Number(product.discountPrice)
          : Number(product.price || 0);
      resolved.push(
        buildItem({
          product: {
            productId: product._id,
            name: product.title,
            slug:
              product.slug ||
              product.seoSlug ||
              product.ShortName ||
              product.code ||
              "",
            sellingPrice,
          },
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          serialNo: item.serialNo,
        }),
      );
    } else {
      resolved.push(
        buildItem({
          name: item?.productName,
          quantity: item?.quantity,
          unitPrice: item?.unitPrice,
          serialNo: item?.serialNo,
        }),
      );
    }
  }
  return { items: resolved };
};

const updateDraft = async (req, res) => {
  try {
    const session = await acquireSession(req, res);
    if (!session) return undefined;
    if (session.status !== "drafting") {
      await release(session);
      return fail(res, 409, "The invoice was already created");
    }

    let { draft } = applyDraftPatch(session.draft, req.body || {});
    if (req.body?.items !== undefined) {
      const { items, error } = await resolveItems(req.body.items);
      if (error) {
        await release(session);
        return fail(res, 400, error);
      }
      draft = { ...draft, items };
    }
    session.draft = draft;
    session.draftVersion += 1;
    await release(session);
    return res.json({ success: true, data: await sessionView(session) });
  } catch (error) {
    return sendAgentError(res, error);
  }
};

// Human-confirmed creation from the CRM "Create & send" button.
const createInvoice = async (req, res) => {
  try {
    const session = await acquireSession(req, res);
    if (!session) return undefined;
    if (session.status === "cancelled") {
      await release(session);
      return fail(res, 409, "This session is closed");
    }

    const result = await createInvoiceFromSession(session, {
      sendEmail: req.body?.sendEmail === true,
      req,
    });
    if (result.created) {
      session.transcript = [
        ...session.transcript,
        {
          role: "system",
          text: `Invoice ${result.invoice.invoiceNo} created from the CRM form.`,
          at: new Date(),
        },
      ];
      // Let the model know for any follow-up questions.
      session.contents = [
        ...session.contents,
        {
          role: "user",
          parts: [
            {
              text: `[Staff created the invoice from the form: ${JSON.stringify(result.invoice)}]`,
            },
          ],
        },
        {
          role: "model",
          parts: [{ text: "Noted, the invoice has been created." }],
        },
      ];
    }
    await release(session);

    const data = await sessionView(session);
    if (result.created || result.alreadyCreated) {
      return res.status(result.created ? 201 : 200).json({
        success: true,
        data,
        alreadyCreated: Boolean(result.alreadyCreated),
      });
    }
    return fail(
      res,
      400,
      result.error ||
        "Fix the highlighted problems before creating the invoice",
      { validation: result.validation, details: result.details, data },
    );
  } catch (error) {
    return sendAgentError(res, error);
  }
};

const emailInvoice = async (req, res) => {
  try {
    const session = await acquireSession(req, res);
    if (!session) return undefined;
    const delivery = await emailSessionInvoice(session);
    await release(session);
    return res
      .status(delivery.success ? 202 : 400)
      .json({ ...delivery, data: await sessionView(session) });
  } catch (error) {
    return sendAgentError(res, error);
  }
};

const cancelSession = async (req, res) => {
  try {
    const session = await acquireSession(req, res);
    if (!session) return undefined;
    if (session.status === "drafting") session.status = "cancelled";
    await release(session);
    return res.json({ success: true, data: await sessionView(session) });
  } catch (error) {
    return sendAgentError(res, error);
  }
};

// Product picker for the CRM draft form (same limited fields as the AI sees).
const searchProducts = async (req, res) => {
  try {
    const products = await searchCatalog(
      String(req.query.q || "").slice(0, 80),
    );
    return res.json({ success: true, data: products });
  } catch (error) {
    return sendAgentError(res, error);
  }
};

const AIInvoiceOperations = {
  createSession,
  listSessions,
  getSession,
  sendMessage,
  updateDraft,
  createInvoice,
  emailInvoice,
  cancelSession,
  searchProducts,
};

export default AIInvoiceOperations;
