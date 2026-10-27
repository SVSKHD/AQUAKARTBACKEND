import Chat, { MAX_CRM_MESSAGES } from "../../models/crm/aiChat.js";
import { GeminiError } from "../gemini.js";

export const chatFailure = (message, status = 400) =>
  new GeminiError(message, status);
export const chatFilter = (staff, id) => {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw chatFailure("Invalid chat id");
  }
  return { _id: id, staff: staff._id };
};
export const chatTitle = (text) =>
  text.trim().replace(/\s+/g, " ").slice(0, 120);
export const chatPatch = (body = {}) => {
  const patch = {};
  if (body.title !== undefined) {
    if (
      typeof body.title !== "string" ||
      !body.title.trim() ||
      body.title.trim().replace(/\s+/g, " ").length > 120
    ) {
      throw chatFailure("title must contain 1 to 120 characters");
    }
    patch.title = chatTitle(body.title);
  }
  for (const field of ["pinned", "archived"]) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "boolean")
      throw chatFailure(`${field} must be a boolean`);
    patch[field] = body[field];
  }
  if (patch.pinned !== undefined)
    patch.pinnedAt = patch.pinned ? new Date() : null;
  if (!Object.keys(patch).length)
    throw chatFailure("Provide title, pinned or archived");
  return patch;
};

// A stored chat is authoritative; a client cannot inject a different transcript
// into an existing conversation or read another staff member's messages.
export const loadCrmChat = async (staff, sessionId) => {
  if (sessionId === undefined || sessionId === null || sessionId === "")
    return null;
  const chat = await Chat.findOne(chatFilter(staff, sessionId))
    .select({ messages: { $slice: -30 } })
    .lean();
  if (!chat) throw chatFailure("Chat not found", 404);
  if (chat.archived)
    throw chatFailure("Restore this chat before sending messages", 409);
  return chat;
};

export const saveCrmTurn = async (staff, chat, options, reply) => {
  const now = new Date();
  const turn = [
    { role: "user", text: options.prompt.trim(), createdAt: now },
    { role: "model", text: reply, createdAt: now },
  ];
  if (chat) {
    const result = await Chat.updateOne(
      {
        ...chatFilter(staff, String(chat._id)),
        archived: false,
        messageCount: chat.messageCount,
      },
      {
        $push: { messages: { $each: turn, $slice: -MAX_CRM_MESSAGES } },
        $inc: { messageCount: 2 },
        $set: { lastMessageAt: now },
      },
      { runValidators: true },
    );
    // Optimistic concurrency prevents mixing replies based on stale histories.
    if (!result.matchedCount)
      throw chatFailure(
        "Chat changed or was deleted. Reload before retrying.",
        409,
      );
    return String(chat._id);
  }
  const prior = options.history
    .filter((message) => message.text.trim())
    .map(({ role, text }) => ({ role, text, createdAt: now }));
  const messages = [...prior, ...turn].slice(-MAX_CRM_MESSAGES);
  const created = await Chat.create({
    staff: staff._id,
    title: chatTitle(
      prior.find((message) => message.role === "user")?.text || options.prompt,
    ),
    messages,
    messageCount: messages.length,
    lastMessageAt: now,
  });
  return String(created._id);
};
