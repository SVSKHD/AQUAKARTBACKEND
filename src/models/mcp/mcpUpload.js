import mongoose from "mongoose";

// One-time image upload URLs created by aquakart_create_image_upload. The
// client PUTs the file to /v1/mcp/uploads/<token> (e.g. `curl -T`), so large
// images never travel as base64 in tool arguments and the OAuth access token
// never reaches the shell. Only the SHA-256 of the token is stored. A
// session accepts one upload, is tied to the staff member and OAuth client
// that created it, and expires (Mongo removes it a day later).

const McpUploadSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    clientId: String,
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    purpose: { type: String, enum: ["blog-image"], default: "blog-image" },
    status: {
      type: String,
      enum: ["pending", "processing", "uploaded", "failed"],
      default: "pending",
    },
    expiresAt: { type: Date, required: true },
    media: { type: mongoose.Schema.Types.ObjectId, ref: "AquaMcpMedia" },
    deduplicated: Boolean,
    error: { code: String, message: String },
    uploadedAt: Date,
  },
  { timestamps: true },
);
McpUploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

const McpUpload =
  mongoose.models.AquaMcpUpload ||
  mongoose.model("AquaMcpUpload", McpUploadSchema);

export default McpUpload;
