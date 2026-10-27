import mongoose from "mongoose";

export const MAX_CRM_MESSAGES = 200;
const Message = new mongoose.Schema({
  role: { type: String, enum: ["user", "model"], required: true },
  text: { type: String, required: true, maxlength: 40000 },
  createdAt: { type: Date, default: Date.now },
});
const Chat = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      required: true,
    },
    title: { type: String, trim: true, maxlength: 120, default: "New chat" },
    messages: { type: [Message], default: [] },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now },
    pinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);
Chat.index({ staff: 1, archived: 1, pinned: -1, lastMessageAt: -1, _id: -1 });

export default mongoose.models.AquaCrmAiChat ||
  mongoose.model("AquaCrmAiChat", Chat);
