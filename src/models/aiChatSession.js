import mongoose from "mongoose";

// Storefront AI chat transcripts for logged-in customers. Guests are not
// persisted; they keep their own short history client-side.
export const MAX_STORED_MESSAGES = 200;

const ChatMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "model"], required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const AiChatSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaEcomUser",
      required: true,
      index: true,
    },
    title: { type: String, trim: true, maxlength: 120, default: "New chat" },
    messages: { type: [ChatMessageSchema], default: [] },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

AiChatSessionSchema.index({ user: 1, lastMessageAt: -1 });

export default mongoose.models.AquaAiChatSession ||
  mongoose.model("AquaAiChatSession", AiChatSessionSchema);
