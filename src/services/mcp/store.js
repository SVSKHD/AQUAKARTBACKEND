import cloudinary from "cloudinary";
import mongoose from "mongoose";
import AquaBlog from "../../models/blog.js";
import AquaProduct from "../../models/product.js";
import McpOperation from "../../models/mcp/mcpOperation.js";
import McpMedia from "../../models/mcp/mcpMedia.js";
import InstagramAsset from "../../models/mcp/instagramAsset.js";
import { PUBLISHED_FILTER, validateTaxonomy } from "../../controllers/blog.js";
import { INSTAGRAM_TEMP_FOLDER } from "./config.js";
import { BlogToolError } from "./errors.js";
import { downloadTrustedFile } from "./imageInput.js";
import { isTempPublicId } from "./instagramTools.js";

// Production implementations of the store/uploader the MCP tools depend
// on: existing Mongoose models and the Cloudinary account configured in
// index.js. Tests inject in-memory fakes instead.

const valid = (id) =>
  mongoose.isValidObjectId(id) && /^[a-f\d]{24}$/i.test(String(id));
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const after = { returnDocument: "after", runValidators: true };
const MCP_BLOG_MEDIA = /^Blogs\/mcp_[a-f0-9]{32}$/;

// Bounded retries for transient storage/network failures.
export const withRetry = async (fn, { attempts = 3, baseMs = 300 } = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = Number(error?.http_code || error?.status || 0);
      const transient =
        status >= 500 ||
        status === 429 ||
        [
          "ETIMEDOUT",
          "ECONNRESET",
          "ECONNREFUSED",
          "EAI_AGAIN",
          "ENOTFOUND",
        ].includes(error?.code) ||
        error?.errorLabels?.includes?.("RetryableWriteError") ||
        error?.name === "MongoNetworkError";
      if (!transient || attempt === attempts) break;
      await new Promise((resolve) =>
        setTimeout(resolve, baseMs * 2 ** (attempt - 1)),
      );
    }
  }
  throw Object.assign(lastError || new Error("Storage failed"), {
    storage: true,
  });
};

const storageError = () =>
  new BlogToolError(
    "STORAGE_UNAVAILABLE",
    "Database write failed; retry with the same idempotencyKey",
  );

export const mongoStore = {
  // Blogs (existing AquaBlog collection)
  findBlog: ({ blogId, slug }) => {
    if (blogId)
      return valid(blogId)
        ? AquaBlog.findById(blogId).select("+integration").lean()
        : null;
    return slug
      ? AquaBlog.findOne({ slug }).select("+integration").lean()
      : null;
  },
  listBlogs: async ({ status, query, skip, limit }) => {
    const filter =
      status === "draft"
        ? { status: "draft" }
        : status === "published"
          ? { ...PUBLISHED_FILTER }
          : {};
    if (query) filter.title = { $regex: escapeRegex(query), $options: "i" };
    const [items, total] = await Promise.all([
      AquaBlog.find(filter)
        .select(
          "title slug status createdAt updatedAt publishedAt titleImages generatedBy +integration",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaBlog.countDocuments(filter),
    ]);
    return { items, total };
  },
  slugTaken: (slug, excludeId) =>
    AquaBlog.exists({
      slug,
      ...(valid(excludeId) ? { _id: { $ne: excludeId } } : {}),
    }).then(Boolean),
  publishedSlugTaken: (slug, excludeId) =>
    AquaBlog.exists({
      slug,
      ...PUBLISHED_FILTER,
      _id: { $ne: excludeId },
    }).then(Boolean),
  findBlogByContentHash: (hash) =>
    AquaBlog.findOne({ "integration.contentHash": hash })
      .select("+integration")
      .lean(),
  listTitles: () => AquaBlog.find({}).select("title").lean(),
  taxonomyError: (payload) => validateTaxonomy(payload),
  productExists: (id) =>
    valid(id) ? AquaProduct.exists({ _id: id }).then(Boolean) : false,
  createBlog: async (doc) => {
    const created = await AquaBlog.create(doc);
    return AquaBlog.findById(created._id).select("+integration").lean();
  },
  updateBlog: (id, condition, change) =>
    valid(id)
      ? AquaBlog.findOneAndUpdate({ _id: id, ...condition }, change, after)
          .select("+integration")
          .lean()
      : null,
  // Mirrors GET /v1/blog-slug/:slug, which the storefront uses.
  firstPublicBlogIdBySlug: async (slug) =>
    slug
      ? (
          await AquaBlog.findOne({ slug, ...PUBLISHED_FILTER })
            .select("_id")
            .lean()
        )?._id || null
      : null,
  blogsUsingImage: (publicId, excludeBlogId) =>
    AquaBlog.exists({
      _id: { $ne: excludeBlogId },
      $or: [{ "titleImages.id": publicId }, { "photos.id": publicId }],
    }).then(Boolean),

  // Blog media uploaded through MCP
  findMediaBySha: (sha256) => McpMedia.findOne({ sha256 }).lean(),
  findMediaById: (id) => (valid(id) ? McpMedia.findById(id).lean() : null),
  findMediaByPublicId: (publicId) => McpMedia.findOne({ publicId }).lean(),
  createMedia: async (doc) => (await McpMedia.create(doc)).toObject(),
  updateMedia: (id, set) =>
    McpMedia.findByIdAndUpdate(id, { $set: set }, after).lean(),

  // Idempotency ledger
  createOperation: async (doc) => (await McpOperation.create(doc)).toObject(),
  findOperation: (clientId, idempotencyKey) =>
    McpOperation.findOne({ clientId, idempotencyKey }).lean(),
  reclaimOperation: (existing, set) =>
    McpOperation.findOneAndUpdate(
      {
        operationId: existing.operationId,
        status: existing.status,
        attempts: existing.attempts,
      },
      {
        $set: { status: "processing", retryable: false, ...set },
        $inc: { attempts: 1 },
      },
      after,
    ).lean(),
  finishOperation: (operationId, set) =>
    withRetry(() => McpOperation.updateOne({ operationId }, { $set: set })),

  // Instagram temporary assets
  findAsset: (assetId) => InstagramAsset.findOne({ assetId }).lean(),
  findAssetBySha: (sha256) => InstagramAsset.findOne({ sha256 }).lean(),
  createAsset: async (doc) => (await InstagramAsset.create(doc)).toObject(),
  updateAsset: (assetId, condition, change) =>
    withRetry(() =>
      InstagramAsset.findOneAndUpdate(
        { assetId, ...condition },
        change,
        after,
      ).lean(),
    ).catch(() => {
      throw storageError();
    }),
  listAssets: async ({ status, skip, limit }) => {
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      InstagramAsset.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InstagramAsset.countDocuments(filter),
    ]);
    return { items, total };
  },
  // Takes one due cleanup with a lease, so several instances never delete
  // the same asset at once and a crashed lease is picked up again.
  claimDueCleanup: (now, lockUntil) =>
    InstagramAsset.findOneAndUpdate(
      {
        status: "CLEANUP_PENDING",
        cleanupStatus: { $in: ["pending", "in_progress"] },
        cleanupAfter: { $ne: null, $lte: now },
        $and: [
          {
            $or: [
              { cleanupNextAttemptAt: null },
              { cleanupNextAttemptAt: { $lte: now } },
            ],
          },
          {
            $or: [
              { cleanupLockedUntil: null },
              { cleanupLockedUntil: { $lt: now } },
            ],
          },
        ],
      },
      { $set: { cleanupStatus: "in_progress", cleanupLockedUntil: lockUntil } },
      { sort: { cleanupAfter: 1 }, returnDocument: "after" },
    ).lean(),
  findAssetsToReconcile: (now, limit) =>
    InstagramAsset.find({
      reconcileAttempts: { $lt: 20 },
      $or: [
        { status: "PUBLISH_UNCERTAIN" },
        {
          status: "PUBLISHING",
          $or: [
            { publishLockedUntil: null },
            { publishLockedUntil: { $lt: now } },
          ],
        },
      ],
    })
      .limit(limit)
      .lean(),
};

const streamUpload = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      options,
      (error, result) =>
        result ? resolve(result) : reject(error || new Error("Upload failed")),
    );
    stream.end(buffer);
  });

const IMAGE_UPLOAD = {
  resource_type: "image",
  overwrite: false,
  allowed_formats: ["jpg", "png", "webp"],
};

export const cloudinaryUploader = {
  download: downloadTrustedFile,
  // Same public id for the same bytes + overwrite:false makes retries safe.
  uploadImage: (buffer, { publicId }) =>
    withRetry(() =>
      streamUpload(buffer, { ...IMAGE_UPLOAD, public_id: publicId }),
    ),
  uploadTemp: (buffer, { publicId }) => {
    if (!isTempPublicId(publicId))
      throw new Error("Refusing to upload outside the Instagram temp folder");
    return withRetry(() =>
      streamUpload(buffer, {
        ...IMAGE_UPLOAD,
        public_id: publicId,
        asset_folder: INSTAGRAM_TEMP_FOLDER,
        tags: ["aquakart-instagram-temp"],
      }),
    );
  },
  // Only ever deletes ids inside aquakart/instagram-temp/.
  destroyTemp: (publicId) => {
    if (!isTempPublicId(publicId))
      throw new Error("Refusing to delete outside the Instagram temp folder");
    return withRetry(() =>
      cloudinary.v2.uploader.destroy(publicId, {
        resource_type: "image",
        type: "upload",
        invalidate: true,
      }),
    );
  },
  // Only MCP-uploaded blog images (Blogs/mcp_<hash>), never staff uploads.
  destroy: (publicId) => {
    if (!MCP_BLOG_MEDIA.test(publicId))
      throw new Error("Refusing to delete a non-MCP image");
    return withRetry(() =>
      cloudinary.v2.uploader.destroy(publicId, {
        resource_type: "image",
        invalidate: true,
      }),
    );
  },
  // Trusted stored logo composited by Cloudinary; the logo is never AI-made.
  brandedUrl: (publicId, config) =>
    cloudinary.v2.url(publicId, {
      secure: true,
      transformation: [
        {
          overlay: config.logoPublicId.replace(/\//g, ":"),
          width: config.logoWidthRatio,
          flags: "relative",
          crop: "scale",
        },
        { flags: "layer_apply", gravity: config.logoGravity, x: 24, y: 24 },
        { fetch_format: "auto", quality: "auto" },
      ],
    }),
  // Instagram accepts JPEG only, so Meta gets a JPEG rendition.
  jpegUrl: (publicId) =>
    cloudinary.v2.url(publicId, {
      secure: true,
      format: "jpg",
      transformation: [{ quality: 90 }],
    }),
};
