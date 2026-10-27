import Chat from "../../models/crm/aiChat.js";
import {
  chatFailure,
  chatFilter,
  chatPatch,
} from "../../services/crm/aiChats.js";
import { GeminiError } from "../../services/gemini.js";

const handle = (action) => async (req, res) => {
  try {
    return await action(req, res);
  } catch (error) {
    if (!(error instanceof GeminiError))
      console.error("CRM chat error:", error);
    return res.status(error instanceof GeminiError ? error.status : 500).json({
      success: false,
      message:
        error instanceof GeminiError
          ? error.message
          : "Failed to manage CRM chats",
    });
  }
};
const findOwned = async (req) => {
  const chat = await Chat.findOne(chatFilter(req.user, req.params.id)).lean();
  if (!chat) throw chatFailure("Chat not found", 404);
  return chat;
};
const booleanQuery = (value, field) => {
  if (value !== "true" && value !== "false")
    throw chatFailure(`${field} must be true or false`);
  return value === "true";
};
const positiveInt = (value, fallback, maximum) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)))
    throw chatFailure("page and limit must be positive integers");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw chatFailure("page or limit is out of range");
  return result;
};
export default {
  create: handle(async (req, res) => {
    const patch =
      req.body?.title !== undefined ? chatPatch({ title: req.body.title }) : {};
    const chat = await Chat.create({ staff: req.user._id, ...patch });
    return res.status(201).json({ success: true, data: chat });
  }),
  list: handle(async (req, res) => {
    const page = positiveInt(req.query.page, 1, 1000000);
    const limit = positiveInt(req.query.limit, 20, 50);
    const filter = {
      staff: req.user._id,
      archived: booleanQuery(req.query.archived ?? "false", "archived"),
    };
    if (req.query.pinned !== undefined)
      filter.pinned = booleanQuery(req.query.pinned, "pinned");
    if (req.query.q !== undefined) {
      if (typeof req.query.q !== "string" || req.query.q.length > 120)
        throw chatFailure("q must be a string of at most 120 characters");
      filter.title = {
        $regex: req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }
    const [chats, total] = await Promise.all([
      Chat.find(filter)
        .select(
          "title pinned pinnedAt archived messageCount lastMessageAt createdAt updatedAt",
        )
        .sort({ pinned: -1, lastMessageAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Chat.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: chats,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }),
  get: handle(async (req, res) =>
    res.json({ success: true, data: await findOwned(req) }),
  ),
  update: handle(async (req, res) => {
    const filter = chatFilter(req.user, req.params.id);
    const patch = chatPatch(req.body);
    const chat = await Chat.findOneAndUpdate(
      filter,
      { $set: patch },
      { returnDocument: "after", runValidators: true },
    )
      .select("-messages")
      .lean();
    if (!chat) throw chatFailure("Chat not found", 404);
    return res.json({ success: true, data: chat });
  }),
  remove: handle(async (req, res) => {
    const result = await Chat.deleteOne(chatFilter(req.user, req.params.id));
    if (!result.deletedCount) throw chatFailure("Chat not found", 404);
    return res.json({ success: true, data: { deleted: true } });
  }),
};
