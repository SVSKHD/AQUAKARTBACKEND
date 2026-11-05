import mongoose from "mongoose";

// One Instagram creative: its temporary Cloudinary copy (always under
// aquakart/instagram-temp/), its Meta container/media, and its cleanup.
// Lifecycle (see docs/MCP_BLOG_PUBLISHING.md):
//   UPLOADED -> CONTAINER_CREATED -> PROCESSING -> READY -> PUBLISHING
//   -> PUBLISHED_VERIFIED -> CLEANUP_PENDING -> CLEANED
// PUBLISH_UNCERTAIN: media_publish may have succeeded but the result was
// lost; it is reconciled with Meta and never cleaned up or re-published
// blindly. FAILED: the container failed; the asset is kept for a retry.

export const INSTAGRAM_STATUSES = [
  "UPLOADED",
  "CONTAINER_CREATED",
  "PROCESSING",
  "READY",
  "PUBLISHING",
  "PUBLISH_UNCERTAIN",
  "PUBLISHED_VERIFIED",
  "CLEANUP_PENDING",
  "CLEANED",
  "FAILED",
];

const InstagramAssetSchema = new mongoose.Schema(
  {
    assetId: { type: String, required: true, unique: true },
    sha256: { type: String, required: true, unique: true },
    cloudinaryPublicId: { type: String, required: true },
    secureUrl: { type: String, required: true },
    // JPEG delivery URL handed to Meta (Instagram accepts JPEG only).
    deliveryUrl: { type: String, required: true },
    format: String,
    bytes: Number,
    width: Number,
    height: Number,
    source: { type: String, enum: ["chatgpt-file", "base64"] },
    clientId: String,
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },

    status: {
      type: String,
      enum: INSTAGRAM_STATUSES,
      default: "UPLOADED",
      index: true,
    },
    caption: String,
    captionHash: String,
    altText: String,
    containerId: String,
    containerStatus: String,
    publishOperationId: String,
    publishLockedUntil: Date,
    publishAttemptAt: Date,
    publishAttempts: { type: Number, default: 0 },
    instagramMediaId: { type: String, default: null },
    permalink: String,
    publishedAt: { type: Date, default: null },
    verifiedAt: Date,
    reconcileAttempts: { type: Number, default: 0 },
    lastError: { code: String, message: String, at: Date },

    cleanupStatus: {
      type: String,
      enum: ["none", "pending", "in_progress", "done", "failed", "blocked"],
      default: "none",
      index: true,
    },
    cleanupAfter: { type: Date, default: null },
    cleanupNextAttemptAt: Date,
    cleanupLockedUntil: Date,
    cleanupAttempts: { type: Number, default: 0 },
    cleanupError: String,
    cleanedAt: Date,

    history: {
      type: [{ _id: false, status: String, at: Date, note: String }],
      default: [],
    },
  },
  { timestamps: true },
);

InstagramAssetSchema.index({
  status: 1,
  cleanupAfter: 1,
  cleanupNextAttemptAt: 1,
});
InstagramAssetSchema.index({ createdAt: -1 });

const InstagramAsset =
  mongoose.models.AquaInstagramAsset ||
  mongoose.model("AquaInstagramAsset", InstagramAssetSchema);

export default InstagramAsset;
