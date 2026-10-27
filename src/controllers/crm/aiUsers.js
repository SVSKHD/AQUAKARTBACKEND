import User from "../../models/user.js";
import Chat from "../../models/aiChatSession.js";
import Blog from "../../models/blog.js";
import mongoose from "mongoose";
import { GeminiError } from "../../services/gemini.js";
import { writeAudit } from "../../services/audit.js";
import {
  escapeRegex,
  fail,
  validId,
  pageQuery,
  questionAnswers,
  generateCustomerBlog,
} from "../../services/crm/customerAi.js";

export const USER_FIELDS =
  "firstName lastName email phone photoURL createdAt lastLoginAt loginCount emailVerified";
const handle = (action) => async (req, res) => {
  try {
    return await action(req, res);
  } catch (error) {
    if (!(error instanceof GeminiError))
      console.error("CRM customer AI error:", error.message);
    return res.status(error instanceof GeminiError ? error.status : 500).json({
      success: false,
      message:
        error instanceof GeminiError
          ? error.message
          : "Failed to load customer AI data",
    });
  }
};
const userProfile = async (id) => {
  if (!validId(id)) throw fail("Invalid user id");
  const user = await User.findById(id).select(USER_FIELDS).lean();
  if (!user) throw fail("User not found", 404);
  return user;
};
const sourceChat = async (userId, chatId) => {
  if (!validId(chatId)) throw fail("Invalid chat id");
  const chat = await Chat.findOne({ _id: chatId, user: userId }).lean();
  if (!chat) throw fail("Customer chat not found", 404);
  return chat;
};
const statsForUsers = async (ids) =>
  Chat.aggregate([
    {
      $match: {
        user: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
      },
    },
    {
      $group: {
        _id: "$user",
        chats: { $sum: 1 },
        messages: { $sum: "$messageCount" },
        lastMessageAt: { $max: "$lastMessageAt" },
      },
    },
  ]);
const emptyStats = { chats: 0, messages: 0, lastMessageAt: null };
const pagination = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

export default {
  list: handle(async (req, res) => {
    const { page, limit } = pageQuery(req.query);
    const filter = {};
    if (req.query.q !== undefined) {
      if (typeof req.query.q !== "string" || req.query.q.length > 120)
        throw fail("q must be a string of at most 120 characters");
      const q = req.query.q.trim();
      const regex = new RegExp(escapeRegex(q), "i");
      filter.$or = [
        { firstName: regex },
        { lastName: regex },
        { email: regex },
      ];
      if (/^\d{6,15}$/.test(q)) filter.$or.push({ phone: Number(q) });
    }
    const [users, total] = await Promise.all([
      User.find(filter)
        .select(USER_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    const stats = users.length
      ? await statsForUsers(users.map((user) => user._id))
      : [];
    const byUser = new Map(
      stats.map(({ _id, ...stat }) => [String(_id), stat]),
    );
    return res.json({
      success: true,
      data: users.map((user) => ({
        ...user,
        ai: byUser.get(String(user._id)) || emptyStats,
      })),
      pagination: pagination(page, limit, total),
    });
  }),
  get: handle(async (req, res) => {
    const user = await userProfile(req.params.userId);
    const stats = await statsForUsers([user._id]);
    const { _id, ...ai } = stats[0] || { ...emptyStats };
    return res.json({ success: true, data: { ...user, ai } });
  }),
  chats: handle(async (req, res) => {
    await userProfile(req.params.userId);
    const { page, limit } = pageQuery(req.query);
    const filter = { user: req.params.userId };
    const [chats, total] = await Promise.all([
      Chat.find(filter)
        .select(
          "title user messageCount lastMessageAt pinned pinnedAt createdAt updatedAt",
        )
        .sort({ lastMessageAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Chat.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: chats,
      pagination: pagination(page, limit, total),
    });
  }),
  chat: handle(async (req, res) => {
    await userProfile(req.params.userId);
    const chat = await sourceChat(req.params.userId, req.params.chatId);
    return res.json({
      success: true,
      data: { ...chat, qa: questionAnswers(chat.messages) },
    });
  }),
  drafts: handle(async (req, res) => {
    await userProfile(req.params.userId);
    await sourceChat(req.params.userId, req.params.chatId);
    const { page, limit } = pageQuery(req.query);
    const filter = { sourceAiChat: req.params.chatId };
    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .select("title slug status generatedBy createdAt")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Blog.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: blogs,
      pagination: pagination(page, limit, total),
    });
  }),
  createDraft: handle(async (req, res) => {
    const user = await userProfile(req.params.userId);
    const chat = await sourceChat(req.params.userId, req.params.chatId);
    const result = await generateCustomerBlog({
      chat,
      user,
      staff: req.user,
      questionIds: req.body?.questionIds,
      instructions: req.body?.instructions,
    });
    await writeAudit({
      req,
      action: "ai.customer-chat.blog-draft",
      resourceType: "blog",
      resourceId: result.blog._id,
      metadata: {
        chatId: String(chat._id),
        questionIds: result.source.questionIds,
      },
    });
    return res.status(201).json({ success: true, data: result });
  }),
};
