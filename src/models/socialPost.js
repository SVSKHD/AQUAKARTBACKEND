import mongoose from "mongoose";

// Social media posts (Instagram now; Facebook stored as a target only)
// created as drafts by the MCP tools (daily automation from Google Drive or
// a poster uploaded by Claude Code), reviewed by staff in the CRM, then
// published as a separate explicit action.
//
// Lifecycle (docs/SOCIAL_DRAFTS.md):
//   draft -> approved -> publishing -> published
//   draft -> rejected -> (edited) -> draft
//   approved -> (edited in the CRM) -> draft (needs approval again)
// The poster lives permanently in Cloudinary (AquaMcpMedia, Blogs/mcp_<sha>)
// until approval and after; Instagram gets its own temporary copy at publish
// time, which the Instagram cleanup worker removes.

export const SOCIAL_PLATFORMS = ["instagram", "facebook"];
export const SOCIAL_STATUSES = [
  "draft",
  "approved",
  "rejected",
  "publishing",
  "published",
];

const PlatformPublishSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["pending", "published", "failed", "unsupported"],
    },
    assetId: String, // AquaInstagramAsset.assetId
    externalId: String, // Instagram media id
    permalink: String,
    publishedAt: Date,
    lastError: { code: String, message: String, at: Date },
  },
  { _id: false },
);

const SocialPostSchema = new mongoose.Schema(
  {
    platforms: {
      type: [{ type: String, enum: SOCIAL_PLATFORMS }],
      validate: (value) => Array.isArray(value) && value.length > 0,
    },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    caption: { type: String, required: true, maxlength: 5000 },
    altText: { type: String, default: "", maxlength: 1000 },
    notes: { type: String, default: "", maxlength: 1000 },
    // Preferred posting time from the content plan; informational only
    // (nothing posts automatically).
    scheduledFor: { type: Date, default: null },
    status: {
      type: String,
      enum: SOCIAL_STATUSES,
      default: "draft",
      index: true,
    },

    media: {
      mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "AquaMcpMedia" },
      publicId: String,
      imageUrl: String,
      width: Number,
      height: Number,
      format: String,
      bytes: Number,
      sha256: String,
    },
    source: {
      type: {
        type: String,
        enum: ["google_drive", "media"],
        default: "media",
      },
      folderId: String,
      imageFileId: String,
      imageVersion: String,
      captionFileId: String,
      captionVersion: String,
      metadataFileId: String,
      metadataVersion: String,
    },
    // sha256(poster sha + caption + platforms): the same post can't be
    // drafted twice.
    contentKey: { type: String, required: true, unique: true },

    review: {
      decision: { type: String, enum: ["approved", "rejected"] },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
      at: Date,
      note: String,
    },
    publishing: {
      instagram: { type: PlatformPublishSchema, default: undefined },
      facebook: { type: PlatformPublishSchema, default: undefined },
      lockedUntil: { type: Date, default: null },
      requestedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AquaAdminUser",
      },
    },
    publishedAt: { type: Date, default: null },

    integration: {
      source: { type: String, enum: ["mcp", "crm"], default: "mcp" },
      clientId: String,
      clientName: String,
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
      createdByOperation: String,
      lastUpdatedByOperation: String,
    },
    history: {
      type: [
        {
          _id: false,
          status: String,
          at: Date,
          by: String,
          note: String,
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

SocialPostSchema.index({ status: 1, createdAt: -1 });
SocialPostSchema.index({ "media.publicId": 1 });
SocialPostSchema.index({ "source.imageFileId": 1 });

const SocialPost =
  mongoose.models.AquaSocialPost ||
  mongoose.model("AquaSocialPost", SocialPostSchema);

export default SocialPost;
