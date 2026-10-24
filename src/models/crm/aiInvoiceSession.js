import mongoose from "mongoose";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const AiInvoiceSessionSchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["drafting", "created", "cancelled"],
      default: "drafting",
      index: true,
    },
    draft: { type: mongoose.Schema.Types.Mixed, required: true },
    draftVersion: { type: Number, default: 0 },
    // Set by the review tool; creation from chat requires a review of the
    // current draft version in an earlier turn.
    review: { type: mongoose.Schema.Types.Mixed, default: null },
    // Products the AI has seen through search, keyed by productId. The AI can
    // only add catalog items from this list.
    knownProducts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // Raw Gemini conversation (includes function calls and thought signatures).
    contents: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Display transcript for the CRM.
    transcript: { type: [mongoose.Schema.Types.Mixed], default: [] },
    turn: { type: Number, default: 0 },
    invoice: { type: mongoose.Schema.Types.Mixed, default: null },
    busyUntil: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + SESSION_TTL_MS),
    },
  },
  { timestamps: true, minimize: false },
);

AiInvoiceSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.AquaAiInvoiceSession ||
  mongoose.model("AquaAiInvoiceSession", AiInvoiceSessionSchema);
