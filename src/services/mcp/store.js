import cloudinary from "cloudinary";
import mongoose from "mongoose";
import AquaBlog from "../../models/blog.js";
import AquaProduct from "../../models/product.js";
import AquaCategory from "../../models/category.js";
import AquaCoupon from "../../models/coupon.js";
import AquaSubCategory from "../../models/sub-category.js";
import AquaSeo from "../../models/seo.js";
import { buildSeoReadiness } from "../seoReadiness.js";
import McpOperation from "../../models/mcp/mcpOperation.js";
import McpMedia from "../../models/mcp/mcpMedia.js";
import McpUpload from "../../models/mcp/mcpUpload.js";
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
// Allowlists of fields the MCP product/coupon tools may read. Dealer prices
// (dpPrice), reviews, reviewer/customer ids are deliberately absent.
const PRODUCT_FIELDS =
  "title ShortName slug code sku brand price discountPrice discountPriceStatus stock category subCategory photos merchantEnabled createdAt description keywords notes gtin mpn condition googleProductCategory productType shippingWeight ratings numberOfReviews";
const TAXONOMY_FIELDS = "title description keywords photos createdAt updatedAt";
const SEO_FIELDS =
  "pageKey route title description keywords canonicalUrl robots ogTitle ogDescription ogImage twitterTitle twitterDescription twitterImage schemaJson active aiLocked aiRefreshedAt createdAt updatedAt";
const exactTitle = (title) =>
  new RegExp(`^\\s*${escapeRegex(title)}\\s*$`, "i");
const COUPON_FIELDS =
  "code description status discountType discountValue maxDiscount minimumOrder startsAt endsAt usageLimit usageCount perUserLimit firstOrderOnly stackable productIds categoryIds userIds createdAt";

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
  // True when another blog, or any product, still shows this image (an
  // MCP-uploaded image can be a blog title image and a product photo).
  blogsUsingImage: async (publicId, excludeBlogId) =>
    Boolean(
      (await AquaBlog.exists({
        _id: { $ne: excludeBlogId },
        $or: [{ "titleImages.id": publicId }, { "photos.id": publicId }],
      })) ||
      (await AquaProduct.exists({ "photos.id": publicId })) ||
      (await AquaCategory.exists({ "photos.id": publicId })) ||
      (await AquaSubCategory.exists({ "photos.id": publicId })),
    ),

  // Categories and subcategories (existing collections)
  listCategories: ({ query }) =>
    AquaCategory.find(
      query ? { title: new RegExp(escapeRegex(query), "i") } : {},
    )
      .select(TAXONOMY_FIELDS)
      .sort({ title: 1 })
      .lean(),
  findCategory: (id) =>
    valid(id) ? AquaCategory.findById(id).select(TAXONOMY_FIELDS).lean() : null,
  findCategoryByTitle: (title) =>
    AquaCategory.findOne({ title: exactTitle(title) })
      .select("_id title +mcpOperation")
      .lean(),
  createCategory: async (doc) => {
    const created = await AquaCategory.create(doc);
    return AquaCategory.findById(created._id).select(TAXONOMY_FIELDS).lean();
  },
  updateCategory: (id, condition, set) =>
    valid(id)
      ? AquaCategory.findOneAndUpdate(
          { _id: id, ...condition },
          { $set: set },
          after,
        )
          .select(TAXONOMY_FIELDS)
          .lean()
      : null,
  deleteCategory: (id) => AquaCategory.findByIdAndDelete(id).lean(),
  taxonomyCounts: async () => {
    const [subs, byCategory, bySub] = await Promise.all([
      AquaSubCategory.aggregate([
        { $group: { _id: "$category", n: { $sum: 1 } } },
      ]),
      AquaProduct.aggregate([{ $group: { _id: "$category", n: { $sum: 1 } } }]),
      AquaProduct.aggregate([
        { $group: { _id: "$subCategory", n: { $sum: 1 } } },
      ]),
    ]);
    const toMap = (rows) =>
      Object.fromEntries(
        rows.filter((row) => row._id).map((row) => [String(row._id), row.n]),
      );
    return {
      subCategories: toMap(subs),
      categoryProducts: toMap(byCategory),
      subCategoryProducts: toMap(bySub),
    };
  },
  listSubCategories: ({ category, query }) => {
    const filter = {};
    if (category && valid(category)) filter.category = category;
    if (query) filter.title = new RegExp(escapeRegex(query), "i");
    return AquaSubCategory.find(filter)
      .select(`${TAXONOMY_FIELDS} category`)
      .populate("category", "_id title")
      .sort({ title: 1 })
      .lean();
  },
  findSubCategory: (id) =>
    valid(id)
      ? AquaSubCategory.findById(id)
          .select(`${TAXONOMY_FIELDS} category`)
          .populate("category", "_id title")
          .lean()
      : null,
  findSubCategoryByTitle: (title) =>
    AquaSubCategory.findOne({ title: exactTitle(title) })
      .select("_id title +mcpOperation")
      .lean(),
  createSubCategory: async (doc) => {
    const created = await AquaSubCategory.create(doc);
    return mongoStore.findSubCategory(String(created._id));
  },
  updateSubCategory: (id, condition, set) =>
    valid(id)
      ? AquaSubCategory.findOneAndUpdate(
          { _id: id, ...condition },
          { $set: set },
          after,
        )
          .select(`${TAXONOMY_FIELDS} category`)
          .populate("category", "_id title")
          .lean()
      : null,
  deleteSubCategory: (id) => AquaSubCategory.findByIdAndDelete(id).lean(),
  productsInSubCategory: (id) =>
    valid(id) ? AquaProduct.countDocuments({ subCategory: id }) : 0,

  // Page SEO (existing AquaSeo collection)
  listSeo: async ({ query, active, skip, limit }) => {
    const filter = {};
    if (active !== undefined) filter.active = active;
    if (query) {
      const pattern = new RegExp(escapeRegex(query), "i");
      filter.$or = [
        { pageKey: pattern },
        { route: pattern },
        { title: pattern },
      ];
    }
    const [items, total] = await Promise.all([
      AquaSeo.find(filter)
        .select(SEO_FIELDS)
        .sort({ pageKey: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaSeo.countDocuments(filter),
    ]);
    return { items, total };
  },
  findSeo: ({ seoId, pageKey }) => {
    if (seoId)
      return valid(seoId)
        ? AquaSeo.findById(seoId).select(`${SEO_FIELDS} +mcpOperation`).lean()
        : null;
    return pageKey
      ? AquaSeo.findOne({ pageKey })
          .select(`${SEO_FIELDS} +mcpOperation`)
          .lean()
      : null;
  },
  createSeo: async (doc) => {
    const created = await AquaSeo.create(doc);
    return AquaSeo.findById(created._id).select(SEO_FIELDS).lean();
  },
  updateSeo: (id, condition, set) =>
    valid(id)
      ? AquaSeo.findOneAndUpdate(
          { _id: id, ...condition },
          { $set: set },
          after,
        )
          .select(SEO_FIELDS)
          .lean()
      : null,
  seoReadiness: (args) => buildSeoReadiness(args),

  // Product catalogue (existing AquaProduct collection). PRODUCT_FIELDS
  // never includes dpPrice, reviews or user.
  listProducts: async ({ query, category, inStock, skip, limit }) => {
    const filter = {};
    if (query) {
      const pattern = new RegExp(escapeRegex(query), "i");
      filter.$or = [
        { title: pattern },
        { ShortName: pattern },
        { code: pattern },
        { sku: pattern },
        { brand: pattern },
      ];
    }
    if (category && valid(category)) filter.category = category;
    if (inStock) filter.stock = { $gt: 0 };
    const [items, total] = await Promise.all([
      AquaProduct.find(filter)
        .select(PRODUCT_FIELDS)
        .populate("category", "_id title")
        .populate("subCategory", "_id title")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaProduct.countDocuments(filter),
    ]);
    return { items, total };
  },
  findProduct: (id) =>
    valid(id)
      ? AquaProduct.findById(id)
          .select(PRODUCT_FIELDS)
          .populate("category", "_id title")
          .populate("subCategory", "_id title")
          .lean()
      : null,
  findProductByTitle: (title) =>
    AquaProduct.findOne({
      title: new RegExp(`^\\s*${escapeRegex(title)}\\s*$`, "i"),
    })
      .select("_id title +mcpOperation")
      .lean(),
  productSkuTaken: (sku) =>
    AquaProduct.exists({
      sku: new RegExp(`^${escapeRegex(sku)}$`, "i"),
    }).then(Boolean),
  createProduct: async (doc) => {
    const created = await AquaProduct.create(doc);
    return mongoStore.findProduct(String(created._id));
  },
  categoryExists: (id) =>
    valid(id) ? AquaCategory.exists({ _id: id }).then(Boolean) : false,

  // Coupons (existing AquaCoupon collection). userIds are counted, never
  // returned.
  listCoupons: async ({ status, query, skip, limit }) => {
    const filter = {};
    if (status) filter.status = status;
    if (query) filter.code = new RegExp(escapeRegex(query), "i");
    const [items, total] = await Promise.all([
      AquaCoupon.find(filter)
        .select(COUPON_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaCoupon.countDocuments(filter),
    ]);
    return { items, total };
  },
  findCoupon: ({ couponId, code }) => {
    if (couponId)
      return valid(couponId)
        ? AquaCoupon.findById(couponId)
            .select(`${COUPON_FIELDS} +mcpOperation`)
            .lean()
        : null;
    return code
      ? AquaCoupon.findOne({ code })
          .select(`${COUPON_FIELDS} +mcpOperation`)
          .lean()
      : null;
  },
  createCoupon: async (doc) => {
    const created = await AquaCoupon.create(doc);
    return AquaCoupon.findById(created._id).select(COUPON_FIELDS).lean();
  },

  // Blog media uploaded through MCP
  findMediaBySha: (sha256) => McpMedia.findOne({ sha256 }).lean(),
  findMediaById: (id) => (valid(id) ? McpMedia.findById(id).lean() : null),
  findMediaByPublicId: (publicId) => McpMedia.findOne({ publicId }).lean(),
  createMedia: async (doc) => (await McpMedia.create(doc)).toObject(),
  updateMedia: (id, set) =>
    McpMedia.findByIdAndUpdate(id, { $set: set }, after).lean(),

  // One-time upload URLs (aquakart_create_image_upload)
  createUpload: async (doc) => (await McpUpload.create(doc)).toObject(),
  findUploadById: (id) => (valid(id) ? McpUpload.findById(id).lean() : null),
  findUploadByTokenHash: (tokenHash) => McpUpload.findOne({ tokenHash }).lean(),
  // pending -> processing, atomically, only before expiry (single use).
  claimUpload: (tokenHash, now) =>
    McpUpload.findOneAndUpdate(
      { tokenHash, status: "pending", expiresAt: { $gt: now } },
      { $set: { status: "processing" } },
      after,
    ).lean(),
  finishUpload: (id, set) =>
    McpUpload.findByIdAndUpdate(id, { $set: set }, after).lean(),

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
  brandedUrl: (publicId, config, variant = "original") =>
    cloudinary.v2.url(publicId, {
      secure: true,
      transformation: [
        {
          overlay: (variant === "white" && config.logoWhitePublicId
            ? config.logoWhitePublicId
            : config.logoPublicId
          ).replace(/\//g, ":"),
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
