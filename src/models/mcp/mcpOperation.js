import mongoose from "mongoose";

// One record per MCP write tool call. It is the idempotency ledger (same
// OAuth client + idempotencyKey replays the stored result), the audit trail
// (staff member, client, operation, result, timestamps) and what lets a
// client re-check a call after a network timeout. Never stores article
// bodies, images or tokens: only a SHA-256 of the arguments, so a reused key
// with different arguments is detected.

const RETENTION_DAYS = Math.max(
  1,
  Number(process.env.MCP_OPERATION_RETENTION_DAYS) || 30,
);

const McpOperationSchema = new mongoose.Schema(
  {
    operationId: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    tool: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    argsHash: { type: String, required: true },
    status: {
      type: String,
      enum: ["processing", "succeeded", "failed"],
      default: "processing",
      index: true,
    },
    // A failed attempt that may be re-run with the same key.
    retryable: { type: Boolean, default: false },
    attempts: { type: Number, default: 1 },
    lockedUntil: Date,
    correlationId: String,
    blogId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaBlog" },
    result: mongoose.Schema.Types.Mixed,
    errorCode: String,
    finishedAt: Date,
    expiresAt: {
      type: Date,
      default: () =>
        new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true },
);

McpOperationSchema.index({ clientId: 1, idempotencyKey: 1 }, { unique: true });
McpOperationSchema.index({ blogId: 1, createdAt: -1 });
McpOperationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const McpOperation =
  mongoose.models.AquaMcpOperation ||
  mongoose.model("AquaMcpOperation", McpOperationSchema);

export default McpOperation;
