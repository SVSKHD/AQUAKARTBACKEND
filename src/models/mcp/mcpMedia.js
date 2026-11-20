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
    source: {
      type: String,
      enum: ["chatgpt-file", "base64", "upload-url", "google-drive"],
    },
    // Where an imported image came from (aquakart_import_blog_banner), so a
    // repeated import of the same file version is recognised without
    // downloading it again.
    sourceRef: {
      type: { type: String, enum: ["google_drive"] },
      fileId: String,
      version: String,
      name: String,
    },
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
