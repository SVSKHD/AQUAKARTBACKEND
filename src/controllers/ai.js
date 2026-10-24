import mongoose from "mongoose";
import AiChatSession, { MAX_STORED_MESSAGES } from "../models/aiChatSession.js";
import {
  GeminiError,
  THINKING_LEVELS,
  generateContent,
  isGeminiConfigured,
  streamContent,
} from "../services/gemini.js";
import {
  carryGuestUsage,
  consumeQuota,
  dailyLimit,
  getQuota,
  quotaSubject,
  refundQuota,
} from "../services/aiQuota.js";
import { getCatalogueInstruction } from "../services/aiCatalogue.js";

const ECOM_LIMITS = { promptChars: 2000, historyTurns: 10, outputTokens: 800 };
// Guests also get fewer questions per day (see services/aiQuota.js).
const GUEST_LIMITS = { promptChars: 1000, historyTurns: 6, outputTokens: 600 };
const HISTORY_PAGE_LIMIT = 50;
const CRM_LIMITS = { promptChars: 20000, historyTurns: 30, outputTokens: 4096 };

// The storefront endpoint is public, so the system prompt is fixed server-side
// to keep it from being used as a general-purpose proxy for our Gemini key.
const ECOM_SYSTEM_INSTRUCTION = [
  "You are the AquaKart shopping assistant for aquakart.co.in, an Indian store",
  "selling water purifiers, water softeners, filters and related services.",
  "Help customers choose products, understand water quality (hardness, TDS),",
  "installation and maintenance. Be concise, friendly and accurate.",
  "Do not invent prices, stock or offers beyond the catalogue below; for current",
  "offers ask the customer to check the product page or contact AquaKart support.",
  "Politely decline requests",
  "unrelated to water treatment, AquaKart products or orders.",
].join(" ");

const CRM_SYSTEM_INSTRUCTION = [
  "You are an assistant for AquaKart staff using the internal CRM.",
  "Help draft customer messages, quotations, product descriptions, summaries",
  "and follow-ups for a water purifier and softener business in India.",
  "Be accurate and professional.",
].join(" ");

const sanitizeHistory = (history, maxTurns, maxChars) => {
  if (!Array.isArray(history)) return [];
  return history.slice(-maxTurns).map((entry) => ({
    role: entry?.role === "user" ? "user" : "model",
    text: String(entry?.text ?? "").slice(0, maxChars),
  }));
};

const sendError = (res, error) => {
  if (error instanceof GeminiError) {
    return res
      .status(error.status)
      .json({ success: false, message: error.message });
  }
  console.error("AI controller error:", error);
  return res
    .status(500)
    .json({ success: false, message: "Failed to generate AI response" });
};

const validatePrompt = (prompt, maxChars) => {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return "prompt is required";
  }
  if (prompt.length > maxChars) {
    return `prompt must be at most ${maxChars} characters`;
  }
  return null;
};

// Storefront: thinking is on/off only and capped at "medium" for latency.
const ecomThinking = (thinking) => (thinking === true ? "medium" : null);

// CRM: true → "medium"; "medium" | "high" pass through.
const crmThinking = (thinking) => {
  if (thinking === true) return "medium";
  return THINKING_LEVELS.includes(thinking) ? thinking : null;
};

const quotaExceeded = (res, quota) =>
  res.status(429).json({
    success: false,
    code: "AI_DAILY_LIMIT",
    loginRequired: quota.tier === "guest",
    message:
      quota.tier === "guest"
        ? `You've used your ${quota.limit} free questions for today. Log in to get ${dailyLimit("user")} questions a day.`
        : `You've used all ${quota.limit} questions for today. Your limit resets at midnight.`,
    quota,
  });

const releaseQuota = (subject, claim) =>
  refundQuota(subject, claim.day).catch((error) => {
    console.error("AI quota refund failed:", error);
  });

const isBlank = (value) =>
  value === undefined || value === null || value === "";

// Logged-in customers continue a stored session by sessionId; its transcript
// replaces any client-sent history. Guests have nothing stored.
const loadChatSession = async (user, sessionId) => {
  if (!user || isBlank(sessionId)) return { session: null };
  if (!mongoose.isValidObjectId(sessionId)) {
    return { status: 400, error: "Invalid sessionId" };
  }
  const session = await AiChatSession.findOne({
    _id: sessionId,
    user: user._id,
  })
    .select({ messages: { $slice: -ECOM_LIMITS.historyTurns } })
    .lean();
  if (!session) return { status: 404, error: "Chat session not found" };
  return { session };
};

// Resolves the request into generateContent/streamContent options (plus the
// stored session, if any), or { status, error }.
const ecomOptions = async (req) => {
  const body = req.body || {};
  const limits = req.user ? ECOM_LIMITS : GUEST_LIMITS;
  const error = validatePrompt(body.prompt, limits.promptChars);
  if (error) return { status: 400, error };

  const { session, ...failure } = await loadChatSession(
    req.user,
    body.sessionId,
  );
  if (failure.error) return failure;

  return {
    session,
    options: {
      prompt: body.prompt,
      history: sanitizeHistory(
        session ? session.messages : body.history,
        limits.historyTurns,
        limits.promptChars,
      ),
      systemInstruction: [
        ECOM_SYSTEM_INSTRUCTION,
        await getCatalogueInstruction(),
      ]
        .filter(Boolean)
        .join("\n\n"),
      temperature: 0.5,
      maxOutputTokens: limits.outputTokens,
      thinking: ecomThinking(body.thinking),
    },
  };
};

const chatTitle = (prompt) => {
  const text = prompt.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

// Saves the completed turn and returns the session id. Only successful replies
// are stored, so a session never ends on an unanswered prompt. A failed save
// is logged rather than failing a reply the customer already has.
// `earlier` (the client's history, already sanitized) seeds a NEW session only:
// a guest who logs in mid-chat keeps their earlier questions in the saved chat.
const saveChatTurn = async (user, session, prompt, reply, earlier = []) => {
  if (!user) return null;
  const now = new Date();
  const turn = [
    { role: "user", text: prompt.trim(), createdAt: now },
    { role: "model", text: reply, createdAt: now },
  ];
  try {
    if (session) {
      await AiChatSession.updateOne(
        { _id: session._id, user: user._id },
        {
          $push: { messages: { $each: turn, $slice: -MAX_STORED_MESSAGES } },
          $inc: { messageCount: turn.length },
          $set: { lastMessageAt: now },
        },
      );
      return String(session._id);
    }
    const prior = (Array.isArray(earlier) ? earlier : [])
      .filter((m) => m && m.text)
      .map((m) => ({
        role: m.role === "user" ? "user" : "model",
        text: m.text,
        createdAt: now,
      }));
    const messages = [...prior, ...turn].slice(-MAX_STORED_MESSAGES);
    const firstQuestion = prior.find((m) => m.role === "user")?.text || prompt;
    const created = await AiChatSession.create({
      user: user._id,
      title: chatTitle(firstQuestion),
      messages,
      messageCount: messages.length,
      lastMessageAt: now,
    });
    return String(created._id);
  } catch (error) {
    console.error("AI chat history save failed:", error);
    return session ? String(session._id) : null;
  }
};

const crmOptions = (body = {}) => {
  const error = validatePrompt(body.prompt, CRM_LIMITS.promptChars);
  if (error) return { error };
  const temperature = Number(body.temperature);
  return {
    options: {
      prompt: body.prompt,
      history: sanitizeHistory(
        body.history,
        CRM_LIMITS.historyTurns,
        CRM_LIMITS.promptChars,
      ),
      systemInstruction:
        typeof body.systemInstruction === "string" &&
        body.systemInstruction.trim()
          ? body.systemInstruction.slice(0, CRM_LIMITS.promptChars)
          : CRM_SYSTEM_INSTRUCTION,
      temperature:
        body.temperature !== undefined &&
        Number.isFinite(temperature) &&
        temperature >= 0 &&
        temperature <= 2
          ? temperature
          : 0.7,
      maxOutputTokens: CRM_LIMITS.outputTokens,
      json: body.json === true,
      thinking: crmThinking(body.thinking),
    },
  };
};

const writeEvent = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// Streams Gemini output as server-sent events over a POST response:
// thought {index,title,text} (upsert by index) · delta {text} · done {...} · error {status,message}
const streamToClient = async (req, res, options, toDone) => {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  let events;
  try {
    events = await streamContent({ ...options, signal: abort.signal });
  } catch (error) {
    // Nothing has been streamed yet, so a normal JSON error still works.
    sendError(res, error);
    return false;
  }

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let completed = false;
  try {
    for await (const event of events) {
      if (event.type === "thought") {
        const { index, title, text } = event;
        writeEvent(res, "thought", { index, title, text });
      } else if (event.type === "text") {
        writeEvent(res, "delta", { text: event.text });
      } else if (event.type === "done") {
        writeEvent(res, "done", await toDone(event));
        completed = true;
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      const status = error instanceof GeminiError ? error.status : 500;
      if (!(error instanceof GeminiError)) {
        console.error("AI stream error:", error);
      }
      writeEvent(res, "error", {
        status,
        message:
          error instanceof GeminiError
            ? error.message
            : "Failed to generate AI response",
      });
    }
  }
  res.end();
  return completed;
};

// A question only counts once it is valid, and is refunded if no answer is
// delivered (AI error, or a stream that ends before its final event).
const ecomChat = async (req, res) => {
  const subject = quotaSubject(req);
  let claim;
  try {
    const { options, session, status, error } = await ecomOptions(req);
    if (error)
      return res.status(status).json({ success: false, message: error });

    claim = await consumeQuota(subject);
    if (!claim.allowed) return quotaExceeded(res, claim.quota);

    const result = await generateContent(options);
    const sessionId = await saveChatTurn(
      req.user,
      session,
      options.prompt,
      result.text,
      options.history,
    );
    return res.json({
      success: true,
      data: {
        reply: result.text,
        ...(options.thinking ? { thoughts: result.thoughts } : {}),
        sessionId,
        guest: !req.user,
        quota: claim.quota,
      },
    });
  } catch (caught) {
    if (claim?.allowed) await releaseQuota(subject, claim);
    return sendError(res, caught);
  }
};

const ecomChatStream = async (req, res) => {
  let resolved;
  try {
    resolved = await ecomOptions(req);
  } catch (caught) {
    return sendError(res, caught);
  }
  const { options, session, status, error } = resolved;
  if (error) return res.status(status).json({ success: false, message: error });

  const subject = quotaSubject(req);
  let claim;
  try {
    claim = await consumeQuota(subject);
  } catch (caught) {
    return sendError(res, caught);
  }
  if (!claim.allowed) return quotaExceeded(res, claim.quota);

  const completed = await streamToClient(
    req,
    res,
    options,
    async ({ reply, thoughts }) => ({
      reply,
      thoughts,
      sessionId: await saveChatTurn(
        req.user,
        session,
        options.prompt,
        reply,
        options.history,
      ),
      guest: !req.user,
      quota: claim.quota,
    }),
  );
  if (!completed) await releaseQuota(subject, claim);
  return undefined;
};

// POST /ai/quota/carry-guest (logged in): count today's guest questions from
// this browser toward the account's daily allowance. Returns the account quota.
const carryQuota = async (req, res) => {
  try {
    return res.json({
      success: true,
      data: await carryGuestUsage(req.user, req.ip),
    });
  } catch (error) {
    console.error("AI quota carry-over failed:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update AI quota" });
  }
};

const quota = async (req, res) => {
  try {
    return res.json({ success: true, data: await getQuota(quotaSubject(req)) });
  } catch (error) {
    console.error("AI quota read failed:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load AI quota" });
  }
};

const listChatHistory = async (req, res) => {
  try {
    const limit = Math.min(
      HISTORY_PAGE_LIMIT,
      Math.max(1, Math.trunc(Number(req.query.limit)) || 20),
    );
    const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
    const filter = { user: req.user._id };
    const [sessions, total] = await Promise.all([
      AiChatSession.find(filter)
        .select("title messageCount lastMessageAt createdAt")
        .sort({ lastMessageAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AiChatSession.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: sessions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("AI chat history list failed:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load chat history" });
  }
};

const findOwnSession = (req) =>
  mongoose.isValidObjectId(req.params.id)
    ? { _id: req.params.id, user: req.user._id }
    : null;

const getChatSession = async (req, res) => {
  try {
    const filter = findOwnSession(req);
    const session = filter && (await AiChatSession.findOne(filter).lean());
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Chat session not found" });
    }
    return res.json({ success: true, data: session });
  } catch (error) {
    console.error("AI chat history read failed:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load chat session" });
  }
};

const deleteChatSession = async (req, res) => {
  try {
    const filter = findOwnSession(req);
    const deleted = filter && (await AiChatSession.findOneAndDelete(filter));
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Chat session not found" });
    }
    return res.json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    console.error("AI chat history delete failed:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete chat session" });
  }
};

const clearChatHistory = async (req, res) => {
  try {
    const { deletedCount } = await AiChatSession.deleteMany({
      user: req.user._id,
    });
    return res.json({ success: true, data: { deleted: deletedCount } });
  } catch (error) {
    console.error("AI chat history clear failed:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to clear chat history" });
  }
};

const crmGenerate = async (req, res) => {
  const { options, error } = crmOptions(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    const result = await generateContent(options);
    return res.json({
      success: true,
      data: {
        reply: result.text,
        ...(options.thinking ? { thoughts: result.thoughts } : {}),
        model: result.model,
        finishReason: result.finishReason,
        usage: result.usage,
      },
    });
  } catch (caught) {
    return sendError(res, caught);
  }
};

const crmGenerateStream = (req, res) => {
  const { options, error } = crmOptions(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  return streamToClient(req, res, options, (done) => ({
    reply: done.reply,
    thoughts: done.thoughts,
    model: done.model,
    finishReason: done.finishReason,
    usage: done.usage,
  }));
};

const status = (_req, res) => {
  res.json({ success: true, data: { configured: isGeminiConfigured() } });
};

const AIOperations = {
  ecomChat,
  ecomChatStream,
  quota,
  carryQuota,
  listChatHistory,
  getChatSession,
  deleteChatSession,
  clearChatHistory,
  crmGenerate,
  crmGenerateStream,
  status,
};

export default AIOperations;
