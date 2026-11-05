import mongoose from "mongoose";

// Images uploaded through the aquakart_upload_image MCP tool. Blogs only
// reference these records (never a URL supplied by the client). The SHA-256
// of the bytes de-duplicates repeat uploads of the same image, and `blog`
// tracks the draft using it so a replaced title image can be cleaned up.

const McpMediaSchema = new mongoose.Schema(
  {
    sha256: { type: String, required: true, unique: true },
    publicId: { type: String, required: true },
    secureUrl: { type: String, required: true },
    format: String,
    bytes: Number,
    width: Number,
    height: Number,
    source: { type: String, enum: ["chatgpt-file", "base64"] },
    clientId: String,
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    blog: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaBlog",
      index: true,
    },
    status: { type: String, enum: ["active", "deleted"], default: "active" },
  },
  { timestamps: true },
);

const McpMedia =
  mongoose.models.AquaMcpMedia ||
  mongoose.model("AquaMcpMedia", McpMediaSchema);

export default McpMedia;
