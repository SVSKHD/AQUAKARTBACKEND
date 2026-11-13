import { createHash, randomBytes } from "node:crypto";
import { BlogToolError } from "./errors.js";
import { MCP_SCOPES } from "./config.js";
import { readImageInput } from "./imageInput.js";
import {
  countWords,
  normalizeBlogFields,
  normalizeTitleKey,
  sniffImageType,
  stripText,
} from "../../validators/mcp/blog.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// 32 random bytes, base64url: the capability in a one-time upload URL.
const UPLOAD_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UPLOAD_FORMATS = ["jpg", "png", "webp"];

// Blog operations behind the Aquakart MCP tools. Works on the existing
// AquaBlog documents (no parallel collection) through an injected `store`,
// so the rules are unit-tested without MongoDB or Cloudinary:
// - new articles are always drafts; publishing is its own scoped tool
// - only drafts are edited; partial updates never touch existing images
// - every write is idempotent (operations.js) and audited
// - storefront visibility is unchanged: drafts stay hidden by
//   PUBLISHED_FILTER in controllers/blog.js

export const revisionOf = (blog) => {
  const stamp = blog?.updatedAt || blog?.createdAt;
  return stamp ? new Date(stamp).toISOString() : "0";
};

export const contentHashOf = ({ title, description }) =>
  createHash("sha256")
    .update(
      `${normalizeTitleKey(title)}\n${stripText(description).toLowerCase()}`,
    )
    .digest("hex");

const idOf = (value) =>
  value?._id ? String(value._id) : value ? String(value) : null;

export const createBlogTools = ({
  store,
  uploader,
  runOperation,
  config,
  now = () => new Date(),
  audit = async () => {},
}) => {
  const blogUrl = (blog) =>
    `${config.storefrontUrl}/blog/${encodeURIComponent(blog.slug || String(blog._id))}`;
  const statusOf = (blog) => blog.status || "published";

  const summary = (blog) => ({
    blogId: String(blog._id),
    title: blog.title,
    slug: blog.slug || null,
    status: statusOf(blog),
    createdAt: blog.createdAt ? new Date(blog.createdAt).toISOString() : null,
    publishedAt: blog.publishedAt
      ? new Date(blog.publishedAt).toISOString()
      : null,
    hasTitleImage: Boolean(blog.titleImages?.length),
    source:
      blog.integration?.source === "mcp" ? "mcp" : blog.generatedBy || "staff",
    revision: revisionOf(blog),
    publicUrl: statusOf(blog) === "published" ? blogUrl(blog) : null,
    adminUrl: config.adminBlogUrl
      ? config.adminBlogUrl.replace(
          "{id}",
          encodeURIComponent(String(blog._id)),
        )
      : null,
  });

  const full = (blog) => ({
    ...summary(blog),
    description: blog.description || "",
    shortDescription: blog.shortDescription || "",
    summary: blog.summary || "",
    keywords: blog.keywords || "",
    keyphrases: blog.keyphrases || "",
    keyHighlights: blog.keyHighlights || [],
    tags: blog.tags || [],
    notes: blog.notes || "",
    brand: blog.brand || "",
    titleImageAlt: blog.titleImageAlt || "",
    category: idOf(blog.category),
    subCategory: idOf(blog.subCategory),
    product: idOf(blog.product),
    titleImages: (blog.titleImages || []).map(({ id, secure_url: url }) => ({
      id,
      secure_url: url,
    })),
    photos: (blog.photos || []).map(({ id, secure_url: url }) => ({
      id,
      secure_url: url,
    })),
    wordCount: countWords(blog.description),
  });

  const loadBlog = async ({ blogId, slug }) => {
    const blog = await store.findBlog({ blogId, slug });
    if (!blog)
      throw new BlogToolError(
        "BLOG_NOT_FOUND",
        "No blog matches that id or slug",
      );
    return blog;
  };

  const checkRevision = (blog, expectedRevision) => {
    if (expectedRevision && expectedRevision !== revisionOf(blog)) {
      throw new BlogToolError(
        "REVISION_CONFLICT",
        "The blog changed since you read it; get it again and retry",
        {
          currentRevision: revisionOf(blog),
        },
      );
    }
  };

  const checkReferences = async (merged) => {
    const taxonomyError = await store.taxonomyError(merged);
    if (taxonomyError)
      throw new BlogToolError("INVALID_REFERENCE", taxonomyError);
    if (merged.product && !(await store.productExists(merged.product))) {
      throw new BlogToolError(
        "INVALID_REFERENCE",
        "Selected product was not found",
      );
    }
  };

  const freeSlug = async (base, excludeId) => {
    let slug = base;
    for (let suffix = 2; await store.slugTaken(slug, excludeId); suffix += 1) {
      if (suffix > 50)
        throw new BlogToolError(
          "SLUG_TAKEN",
          "Could not find a free slug; pass one explicitly",
        );
      slug = `${base}-${suffix}`.slice(0, 80);
    }
    return slug;
  };

  const audited = (action, ctx, operation, blogId, metadata = {}) =>
    audit({
      action,
      adminUserId: ctx.auth.adminUserId,
      resourceType: "blog",
      resourceId: blogId,
      metadata: {
        clientId: ctx.auth.clientId,
        operationId: operation.operationId,
        correlationId: ctx.correlationId,
        ...metadata,
      },
    });

  const run = (ctx, tool, args, execute) =>
    runOperation(
      {
        clientId: ctx.auth.clientId,
        adminUserId: ctx.auth.adminUserId,
        tool,
        idempotencyKey: args.idempotencyKey,
        args,
        correlationId: ctx.correlationId,
      },
      execute,
    );

  const hasScope = (ctx, scope) => ctx.auth.scopes.includes(scope);

  // Stores verified image bytes in Cloudinary once (de-duplicated by
  // SHA-256) and records them as McpMedia. `auth` is the staff member and
  // OAuth client the image is attributed to.
  const saveImage = async (input, auth, meta) => {
    const existing = await store.findMediaBySha(input.sha256);
    if (existing?.status === "active") {
      return { media: mediaView(existing), deduplicated: true };
    }
    const uploaded = await uploader.uploadImage(input.buffer, {
      publicId: `Blogs/mcp_${input.sha256.slice(0, 32)}`,
    });
    const record = {
      sha256: input.sha256,
      publicId: uploaded.public_id,
      secureUrl: uploaded.secure_url,
      format: uploaded.format || input.type.format,
      bytes: uploaded.bytes || input.buffer.length,
      width: uploaded.width,
      height: uploaded.height,
      source: input.source,
      clientId: auth.clientId,
      adminUser: auth.adminUserId,
      status: "active",
    };
    const media = existing
      ? await store.updateMedia(existing._id, { ...record, blog: null })
      : await store.createMedia(record).catch(async (error) => {
          if (error?.code === 11000) return store.findMediaBySha(input.sha256);
          throw error;
        });
    await audit({
      action: "mcp.media.upload",
      adminUserId: auth.adminUserId,
      resourceType: "media",
      resourceId: media._id,
      metadata: {
        clientId: auth.clientId,
        operationId: meta.operationId,
        correlationId: meta.correlationId,
        source: input.source,
      },
    });
    return { media: mediaView(media), deduplicated: false };
  };

  // Raw bytes from an upload URL: size and real type (from the bytes).
  const verifyUploadBytes = (buffer) => {
    if (!Buffer.isBuffer(buffer) || !buffer.length)
      throw new BlogToolError(
        "VALIDATION_FAILED",
        "The request body is empty; send the image bytes (e.g. curl -T banner.png <uploadUrl>)",
      );
    if (buffer.length > config.imageMaxBytes)
      throw new BlogToolError(
        "IMAGE_TOO_LARGE",
        `Image exceeds ${config.imageMaxBytes} bytes`,
      );
    const type = sniffImageType(buffer);
    if (!type || !UPLOAD_FORMATS.includes(type.format))
      throw new BlogToolError(
        "UNSUPPORTED_IMAGE_TYPE",
        "Image must be JPG, PNG, WEBP (checked from the file contents)",
      );
    return { buffer, type, sha256: sha256(buffer), source: "upload-url" };
  };

  return {
    // Official logo files and rules for MCP clients that generate images.
    getBrandAssets() {
      const { brand } = config;
      return {
        brand: {
          name: brand.name,
          logos: [
            {
              variant: "original",
              url: brand.logoUrl,
              previewUrl: brand.badgeUrl,
              format: "png",
              useOn: "light or white backgrounds",
            },
            {
              variant: "white",
              url: brand.logoWhiteUrl,
              previewUrl: brand.badgeWhiteUrl,
              format: "png",
              useOn: "dark backgrounds and photos",
            },
          ],
          overlay: {
            available: Boolean(config.logoPublicId),
            howTo:
              "For a blog title image, generate the artwork WITHOUT a logo, upload it with aquakart_upload_image, then call aquakart_attach_image with applyBrandLogo: true (logoVariant 'white' on dark images). The server composites the real logo file, bottom-right.",
          },
          rules: [
            "Use `url` (the clean logo file) as the visual reference; `previewUrl` is only a round badge rendition for display, so do not copy its red border or dark circle.",
            "Never redraw, re-letter, recolour, stretch, rotate, crop or add effects to the logo. If an image needs the logo and you cannot place the exact file, leave clear space and use the logo overlay instead.",
            "Use the original logo on light backgrounds and the white logo on dark backgrounds or busy photos.",
            "Keep clear space around the logo of at least a quarter of its height, and keep it legible (roughly 15-20% of the image width).",
            "Do not invent taglines, certifications or partner logos.",
          ],
        },
      };
    },

    async listBlogs({ status = "all", query, page = 1, limit = 20 }) {
      const { items, total } = await store.listBlogs({
        status,
        query,
        skip: (page - 1) * limit,
        limit,
      });
      return { blogs: items.map(summary), page, limit, total };
    },

    async getBlog(args) {
      return { blog: full(await loadBlog(args)) };
    },

    async getBlogStatus(args) {
      const blog = await loadBlog(args);
      const result = {
        blogId: String(blog._id),
        title: blog.title,
        slug: blog.slug || null,
        status: statusOf(blog),
        publishedAt: blog.publishedAt
          ? new Date(blog.publishedAt).toISOString()
          : null,
        revision: revisionOf(blog),
        hasTitleImage: Boolean(blog.titleImages?.length),
        publicUrl: null,
        visibleOnStorefront: false,
      };
      if (result.status === "published") {
        const firstId = await store.firstPublicBlogIdBySlug(blog.slug);
        result.publicUrl = blogUrl(blog);
        result.visibleOnStorefront =
          Boolean(blog.slug) && String(firstId) === String(blog._id);
      }
      return result;
    },

    async createBlog(args, ctx) {
      const { blog } = normalizeBlogFields(args, { partial: false });
      const warnings = [];
      if (blog.description !== String(args.description).trim())
        warnings.push("HTML_SANITIZED");
      const outcome = await run(
        ctx,
        "aquakart_create_blog",
        args,
        async (operation) => {
          await checkReferences(blog);
          const contentHash = contentHashOf(blog);
          const sameContent = await store.findBlogByContentHash(contentHash);
          if (sameContent) {
            // A crashed earlier attempt of this very operation already saved it.
            if (
              sameContent.integration?.createdByOperation ===
              operation.operationId
            ) {
              return {
                result: { blog: summary(sameContent), warnings },
                blogId: sameContent._id,
              };
            }
            throw new BlogToolError(
              "DUPLICATE_CONTENT",
              "This article was already submitted",
              {
                blogId: String(sameContent._id),
              },
            );
          }
          const titleKey = normalizeTitleKey(blog.title);
          const sameTitle = (await store.listTitles()).find(
            (item) => normalizeTitleKey(item.title) === titleKey,
          );
          if (sameTitle) {
            throw new BlogToolError(
              "DUPLICATE_TITLE",
              "A blog with this title already exists",
              {
                blogId: String(sameTitle._id),
              },
            );
          }
          if (args.slug) {
            if (await store.slugTaken(args.slug)) {
              throw new BlogToolError(
                "SLUG_TAKEN",
                "That slug is already used by another blog",
                { slug: args.slug },
              );
            }
          } else {
            const base = blog.slug || `aquakart-blog-${now().getTime()}`;
            blog.slug = await freeSlug(base);
            if (blog.slug !== base) warnings.push("SLUG_ADJUSTED");
          }

          let created;
          try {
            created = await store.createBlog({
              ...blog,
              status: "draft",
              generatedBy: "ai",
              titleImages: [],
              photos: [],
              createdAt: now(),
              updatedAt: now(),
              integration: {
                source: "mcp",
                clientId: ctx.auth.clientId,
                clientName: ctx.auth.clientName,
                createdBy: ctx.auth.adminUserId,
                contentHash,
                modelUsed: args.modelUsed || undefined,
                createdByOperation: operation.operationId,
              },
            });
          } catch (error) {
            if (error?.code === 11000) {
              throw new BlogToolError(
                "DUPLICATE_CONTENT",
                "This article was already submitted",
              );
            }
            throw error;
          }
          await audited("mcp.blog.create", ctx, operation, created._id);
          return {
            result: { blog: summary(created), warnings },
            blogId: created._id,
          };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    async updateBlog(args, ctx) {
      const {
        blogId,
        expectedRevision,
        idempotencyKey: _key,
        ...fields
      } = args;
      if (!Object.values(fields).some((value) => value !== undefined)) {
        throw new BlogToolError("VALIDATION_FAILED", "No fields to update");
      }
      const { blog: changes } = normalizeBlogFields(fields, { partial: true });
      const outcome = await run(
        ctx,
        "aquakart_update_blog",
        args,
        async (operation) => {
          const current = await loadBlog({ blogId });
          if (statusOf(current) !== "draft") {
            throw new BlogToolError(
              "BLOG_NOT_DRAFT",
              "Only drafts can be edited through MCP; ask staff to edit live posts in the CRM",
            );
          }
          checkRevision(current, expectedRevision);
          if (
            changes.slug &&
            changes.slug !== current.slug &&
            (await store.slugTaken(changes.slug, blogId))
          ) {
            throw new BlogToolError(
              "SLUG_TAKEN",
              "That slug is already used by another blog",
              { slug: changes.slug },
            );
          }
          await checkReferences({
            category:
              changes.category !== undefined
                ? changes.category
                : idOf(current.category),
            subCategory:
              changes.subCategory !== undefined
                ? changes.subCategory
                : idOf(current.subCategory),
            product:
              changes.product !== undefined
                ? changes.product
                : idOf(current.product),
          });
          const set = {
            ...changes,
            "integration.lastUpdatedByOperation": operation.operationId,
          };
          if (
            current.integration?.source === "mcp" &&
            (changes.title || changes.description)
          ) {
            set["integration.contentHash"] = contentHashOf({
              title: changes.title ?? current.title,
              description: changes.description ?? current.description,
            });
          }
          if (current.integration?.source !== "mcp")
            delete set["integration.lastUpdatedByOperation"];
          let updated;
          try {
            updated = await store.updateBlog(
              blogId,
              { status: "draft", updatedAt: current.updatedAt ?? null },
              { $set: set },
            );
          } catch (error) {
            if (error?.code === 11000)
              throw new BlogToolError(
                "DUPLICATE_CONTENT",
                "Another blog already has this content",
              );
            throw error;
          }
          if (!updated) {
            throw new BlogToolError(
              "REVISION_CONFLICT",
              "The blog changed while updating; get it again and retry",
            );
          }
          await audited("mcp.blog.update", ctx, operation, blogId, {
            fields: Object.keys(changes),
          });
          return { result: { blog: summary(updated) }, blogId };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    async uploadImage(args, ctx) {
      // file_id (not the expiring download_url) identifies a ChatGPT file
      // for idempotency; inline bytes are identified by their hash.
      const identity = {
        idempotencyKey: args.idempotencyKey,
        file: args.image ? args.image.file_id : undefined,
        base64: args.imageBase64
          ? createHash("sha256").update(args.imageBase64).digest("hex")
          : undefined,
      };
      const outcome = await run(
        ctx,
        "aquakart_upload_image",
        identity,
        async (operation) => {
          const input = await readImageInput(args, {
            maxBytes: config.imageMaxBytes,
            trustedHosts: config.trustedFileHosts,
            download: uploader.download,
          });
          return {
            result: await saveImage(input, ctx.auth, {
              operationId: operation.operationId,
              correlationId: ctx.correlationId,
            }),
          };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    // aquakart_create_image_upload: a one-time URL the client PUTs the file
    // to, so images never travel as base64 in tool arguments. Not
    // idempotent on purpose: a retry just creates another short-lived URL.
    async createImageUpload(_args, ctx) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(
        now().getTime() + config.uploadUrlTtlSeconds * 1000,
      );
      const upload = await store.createUpload({
        tokenHash: sha256(token),
        clientId: ctx.auth.clientId,
        adminUser: ctx.auth.adminUserId,
        purpose: "blog-image",
        status: "pending",
        expiresAt,
      });
      const uploadUrl = `${config.resourceUrl}/uploads/${token}`;
      return {
        upload: {
          uploadId: String(upload._id),
          uploadUrl,
          method: "PUT",
          expiresAt: expiresAt.toISOString(),
          maxBytes: config.imageMaxBytes,
          acceptedTypes: ["image/png", "image/jpeg", "image/webp"],
        },
        instructions: `PUT the raw image bytes to uploadUrl before ${expiresAt.toISOString()}, e.g. curl --fail -sS -T banner.png "${uploadUrl}". No Authorization header is needed (the URL is the credential; do not share it). It accepts one successful upload. Then call aquakart_get_image_upload with this uploadId to get the mediaId for aquakart_attach_image.`,
      };
    },

    // aquakart_get_image_upload: status of an upload URL and, once the file
    // arrived, the stored media (mediaId) to attach.
    async getImageUpload({ uploadId }, ctx) {
      const upload = await store.findUploadById(uploadId);
      if (!upload || String(upload.adminUser) !== String(ctx.auth.adminUserId))
        throw new BlogToolError("UPLOAD_NOT_FOUND", "No upload with that id");
      const expired =
        upload.status === "pending" && new Date(upload.expiresAt) <= now();
      const media = upload.media
        ? await store.findMediaById(String(upload.media))
        : null;
      return {
        upload: {
          uploadId: String(upload._id),
          status: expired ? "expired" : upload.status,
          expiresAt: new Date(upload.expiresAt).toISOString(),
          uploadedAt: upload.uploadedAt
            ? new Date(upload.uploadedAt).toISOString()
            : null,
          lastError: upload.error?.code
            ? { code: upload.error.code, message: upload.error.message }
            : null,
        },
        media: media ? mediaView(media) : null,
        deduplicated:
          typeof upload.deduplicated === "boolean" ? upload.deduplicated : null,
      };
    },

    // PUT /v1/mcp/uploads/:token (HTTP route, not a tool). Single use on
    // success; a rejected file (wrong type, too big) or a storage failure
    // leaves the URL usable until it expires.
    async completeImageUpload(token, buffer, { correlationId } = {}) {
      if (typeof token !== "string" || !UPLOAD_TOKEN.test(token))
        throw new BlogToolError(
          "UPLOAD_NOT_FOUND",
          "Unknown or expired upload URL",
        );
      const tokenHash = sha256(token);
      const claimed = await store.claimUpload(tokenHash, now());
      if (!claimed) {
        const existing = await store.findUploadByTokenHash(tokenHash);
        if (existing?.status === "uploaded")
          throw new BlogToolError(
            "UPLOAD_ALREADY_USED",
            "This upload URL was already used; create a new one",
            {
              uploadId: String(existing._id),
              mediaId: existing.media ? String(existing.media) : null,
            },
          );
        if (existing?.status === "processing")
          throw new BlogToolError(
            "UPLOAD_IN_PROGRESS",
            "An upload to this URL is in progress",
          );
        throw new BlogToolError(
          "UPLOAD_NOT_FOUND",
          "Unknown or expired upload URL",
        );
      }
      try {
        const saved = await saveImage(
          verifyUploadBytes(buffer),
          { clientId: claimed.clientId, adminUserId: claimed.adminUser },
          { operationId: `upload:${claimed._id}`, correlationId },
        );
        await store.finishUpload(claimed._id, {
          status: "uploaded",
          media: saved.media.mediaId,
          deduplicated: saved.deduplicated,
          uploadedAt: now(),
          error: null,
        });
        return { uploadId: String(claimed._id), ...saved };
      } catch (error) {
        const known = error instanceof BlogToolError;
        await store.finishUpload(claimed._id, {
          status: "pending",
          error: {
            code: known ? error.code : "UPLOAD_FAILED",
            message: known ? error.message : "Storing the image failed",
          },
        });
        throw error;
      }
    },

    async attachImage(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_attach_image",
        args,
        async (operation) => {
          const blog = await loadBlog({ blogId: args.blogId });
          if (
            statusOf(blog) !== "draft" &&
            !hasScope(ctx, MCP_SCOPES.publish)
          ) {
            throw new BlogToolError(
              "INSUFFICIENT_SCOPE",
              "Changing a live blog's image needs blogs:publish",
              {
                missing: [MCP_SCOPES.publish],
              },
            );
          }
          checkRevision(blog, args.expectedRevision);
          const media = await store.findMediaById(args.mediaId);
          if (!media || media.status !== "active") {
            throw new BlogToolError(
              "MEDIA_NOT_FOUND",
              "Upload the image with aquakart_upload_image first",
            );
          }
          if (args.applyBrandLogo && !config.logoPublicId) {
            throw new BlogToolError(
              "LOGO_NOT_CONFIGURED",
              "Logo overlays are turned off (AQUAKART_LOGO_PUBLIC_ID=none)",
            );
          }
          const titleImage = {
            id: media.publicId,
            secure_url: args.applyBrandLogo
              ? uploader.brandedUrl(
                  media.publicId,
                  config,
                  args.logoVariant || "original",
                )
              : media.secureUrl,
          };
          const previous = blog.titleImages?.[0];
          const set = { titleImages: [titleImage] };
          if (args.altText !== undefined)
            set.titleImageAlt = String(args.altText).trim();
          const updated = await store.updateBlog(
            args.blogId,
            { updatedAt: blog.updatedAt ?? null },
            { $set: set },
          );
          if (!updated)
            throw new BlogToolError(
              "REVISION_CONFLICT",
              "The blog changed while updating; retry",
            );
          await store.updateMedia(media._id, { blog: blog._id });
          if (previous?.id && previous.id !== media.publicId)
            await releasePrevious(previous.id, blog._id);
          await audited("mcp.blog.attach_image", ctx, operation, args.blogId, {
            mediaId: String(media._id),
          });
          return {
            result: {
              blog: summary(updated),
              titleImage,
              titleImageAlt: updated.titleImageAlt || "",
              logoApplied: Boolean(args.applyBrandLogo),
            },
            blogId: args.blogId,
          };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    async publishBlog(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_publish_blog",
        args,
        async (operation) => {
          const blog = await loadBlog({ blogId: args.blogId });
          if (statusOf(blog) === "published") {
            return {
              result: await publishedView(blog, true),
              blogId: args.blogId,
            };
          }
          checkRevision(blog, args.expectedRevision);
          const failures = [];
          if (!blog.title || blog.title.length < 10)
            failures.push({
              check: "title",
              message: "Title needs 10+ characters",
            });
          if (!blog.slug)
            failures.push({ check: "slug", message: "Slug is missing" });
          const words = countWords(blog.description);
          if (words < config.publishMinWords) {
            failures.push({
              check: "wordCount",
              message: `Article has ${words} words; needs ${config.publishMinWords}`,
            });
          }
          if (
            config.publishRequireShortDescription &&
            (blog.shortDescription || "").length < 50
          ) {
            failures.push({
              check: "shortDescription",
              message: "Meta description needs 50+ characters",
            });
          }
          if (config.publishRequireTitleImage && !blog.titleImages?.length) {
            failures.push({
              check: "titleImage",
              message: "Attach a title image first",
            });
          }
          if (
            blog.slug &&
            (await store.publishedSlugTaken(blog.slug, args.blogId))
          ) {
            failures.push({
              check: "slug",
              message: "Another published blog already uses this slug",
            });
          }
          if (failures.length) {
            throw new BlogToolError(
              "PUBLISH_CHECKS_FAILED",
              "The draft is not ready to publish",
              failures,
            );
          }
          const published = await store.updateBlog(
            args.blogId,
            { status: "draft", updatedAt: blog.updatedAt ?? null },
            {
              $set: {
                status: "published",
                publishedAt: now(),
                "integration.publishedByOperation": operation.operationId,
                "integration.publishedBy": ctx.auth.adminUserId,
              },
            },
          );
          if (!published) {
            const latest = await loadBlog({ blogId: args.blogId });
            if (statusOf(latest) === "published")
              return {
                result: await publishedView(latest, true),
                blogId: args.blogId,
              };
            throw new BlogToolError(
              "REVISION_CONFLICT",
              "The blog changed while publishing; get it again and retry",
            );
          }
          await audited("mcp.blog.publish", ctx, operation, args.blogId);
          return {
            result: await publishedView(published, false),
            blogId: args.blogId,
          };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },
  };

  async function publishedView(blog, alreadyPublished) {
    const firstId = await store.firstPublicBlogIdBySlug(blog.slug);
    return {
      blog: summary(blog),
      alreadyPublished,
      publicUrl: blogUrl(blog),
      visibleOnStorefront:
        Boolean(blog.slug) && String(firstId) === String(blog._id),
    };
  }

  function mediaView(media) {
    return {
      mediaId: String(media._id),
      publicId: media.publicId,
      secure_url: media.secureUrl,
      format: media.format,
      bytes: media.bytes,
      width: media.width ?? null,
      height: media.height ?? null,
    };
  }

  // Removes a replaced title image only if MCP uploaded it and no other
  // blog uses it; staff-uploaded images are never deleted.
  async function releasePrevious(publicId, blogId) {
    try {
      const media = await store.findMediaByPublicId(publicId);
      if (!media || media.status !== "active") return;
      if (await store.blogsUsingImage(publicId, blogId)) return;
      await uploader.destroy(publicId);
      await store.updateMedia(media._id, { status: "deleted", blog: null });
    } catch (error) {
      console.error(
        "MCP: could not remove replaced title image:",
        error.message,
      );
    }
  }
};
